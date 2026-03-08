import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type AddressLookupTableAccount,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import { loadEnv } from '../config/env.js';
import { normalizeWslPath } from '../utils/path.js';
import { getConnection } from '../solana/connection.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';
import { buildPlanTransactions, type BuiltPlanTx } from '../execute/planTxBuilder.js';
import { extractValidationPaths, verifyJitoTipMutation } from '../execute/landingEdgeValidation.js';
import {
  getPlanCooldownAnchorMs,
  setKlendHealthyCooldown,
  shouldSkipForKlendHealthyCooldown,
  type KlendHealthyCooldownEntry,
} from '../execute/klendHealthyCooldown.js';
import { quotePriorityFeeMicroLamports } from '../execute/priorityFeePolicy.js';
import { fetchJitoTipAccounts } from '../execute/jitoSender.js';
import { withOptionalJitoTipInstruction } from '../execute/executor.js';
import { buildVersionedTx } from '../execute/versionedTx.js';
import {
  buildPreLiquidationValidationPath,
  type PreLiquidationValidationBuild,
} from '../execute/preLiquidationValidationBuilder.js';

type Status = 'PASS' | 'WARN' | 'FAIL';
const DETERMINISTIC_TEST_TIMESTAMP_MS = 1_000_000;
const DETERMINISTIC_TEST_HEALTH_RATIO = 1.012345;

export type CliArgs = {
  planKey?: string;
  json: boolean;
  strictJito: boolean;
  strictRecentFees: boolean;
};

type ValidationPath = {
  pathLabel: string;
  instructions: TransactionInstruction[];
  labels: string[];
  lookupTables?: AddressLookupTableAccount[];
};

type FeeQuoteSummary = {
  pathLabel: string;
  mode: string;
  writableAccountsSampled: number;
  observedSamples: number;
  observedNonZeroSamples: number;
  recommendedMicroLamports: number;
  status: Status;
  note?: string;
};

type JitoValidationSummary = {
  status: Status;
  pathLabel: string;
  tipAccountsCount: number;
  tipFetchOk: boolean;
  tipAdded: boolean;
  compiled: boolean;
  note?: string;
};

export type LandingEdgeSummary = {
  selectedPlanKey: string;
  cooldown: Status;
  fees: Status;
  jito: Status;
  fullBuild: Status;
  fullBuildReason?: string;
  overall: Status;
  pathLabels: string[];
  feeResults: FeeQuoteSummary[];
  jitoResult: JitoValidationSummary;
  cooldownChecks: {
    sameAnchorBeforeExpiry: boolean;
    anchorChangeInvalidates: boolean;
    afterExpiryClears: boolean;
  };
};

type LandingEdgeEnv = ReturnType<typeof loadEnv>;

export interface LandingEdgeValidationDeps {
  buildPreLiquidationValidationPath: (args: {
    connection: Connection;
    plan: FlashloanPlan;
    feePayer: PublicKey;
  }) => Promise<PreLiquidationValidationBuild>;
  buildPlanTransactions: (args: {
    connection: Connection;
    signer: Keypair;
    market: PublicKey;
    programId: PublicKey;
    plan: FlashloanPlan;
    includeSwap: boolean;
    useRealSwapSizing: boolean;
    dry: boolean;
  }) => Promise<BuiltPlanTx>;
  quotePriorityFeeMicroLamports: typeof quotePriorityFeeMicroLamports;
  fetchJitoTipAccounts: typeof fetchJitoTipAccounts;
  withOptionalJitoTipInstruction: typeof withOptionalJitoTipInstruction;
  buildVersionedTx: typeof buildVersionedTx;
}

const defaultDeps: LandingEdgeValidationDeps = {
  buildPreLiquidationValidationPath,
  buildPlanTransactions,
  quotePriorityFeeMicroLamports,
  fetchJitoTipAccounts,
  withOptionalJitoTipInstruction,
  buildVersionedTx,
};

function parseCliArgs(args: string[]): CliArgs {
  return {
    planKey: args.find((a) => a.startsWith('--plan-key='))?.split('=')[1],
    json: args.includes('--json'),
    strictJito: args.includes('--strict-jito'),
    strictRecentFees: args.includes('--strict-recent-fees'),
  };
}

function loadQueuePlans(): FlashloanPlan[] {
  const queuePath = path.join(process.cwd(), 'data', 'tx_queue.json');
  if (!fs.existsSync(queuePath)) {
    throw new Error(`Queue file missing: ${queuePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Queue file is empty: ${queuePath}`);
  }
  return parsed as FlashloanPlan[];
}

function loadSigner(botKeypairPath: string): Keypair {
  const kpPath = normalizeWslPath(botKeypairPath);
  if (!kpPath || !fs.existsSync(kpPath)) {
    throw new Error(`BOT_KEYPAIR_PATH does not exist: ${kpPath}`);
  }
  const secret = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function isOrdinaryFullBuildFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('derived repay amount is zero') ||
    lower.includes('borrow may be too small to liquidate') ||
    lower.includes('swap required') ||
    lower.includes('tx too large')
  );
}

async function quoteFeeForPath(args: {
  path: ValidationPath;
  connection: Connection;
  signer: Keypair;
  env: LandingEdgeEnv;
  staticCuPrice: number;
  strictRecentFees: boolean;
  required: boolean;
  deps: LandingEdgeValidationDeps;
}): Promise<FeeQuoteSummary> {
  try {
    const quote = await args.deps.quotePriorityFeeMicroLamports({
      connection: args.connection,
      instructions: args.path.instructions,
      payer: args.signer.publicKey,
      staticMicroLamports: args.staticCuPrice,
      mode: args.env.EXEC_PRIORITY_FEE_MODE,
      percentile: Number(args.env.EXEC_PRIORITY_FEE_PERCENTILE),
      floorMicroLamports: Number(args.env.EXEC_PRIORITY_FEE_FLOOR_MICROLAMPORTS),
      capMicroLamports: Number(args.env.EXEC_PRIORITY_FEE_CAP_MICROLAMPORTS),
      maxAccounts: Number(args.env.EXEC_PRIORITY_FEE_SAMPLE_ACCOUNTS_LIMIT),
    });
    console.log(
      `[LandingEdgeValidation] priority-fee path=${args.path.pathLabel} mode=${quote.mode} writableAccounts=${quote.writableAccountsSampled} samples=${quote.observedSamples} nonZeroSamples=${quote.observedNonZeroSamples} microLamports=${quote.recommendedMicroLamports}`
    );
    let status: Status = 'PASS';
    let note: string | undefined;
    if (args.env.EXEC_PRIORITY_FEE_MODE === 'recent-fees' && (quote.mode === 'static' || quote.observedSamples === 0)) {
      status = args.strictRecentFees ? 'FAIL' : 'WARN';
      note = 'recent-fees fallback detected';
    }
    if (!Number.isFinite(quote.recommendedMicroLamports) || quote.recommendedMicroLamports < 0) {
      status = args.required ? 'FAIL' : 'WARN';
      note = note ?? 'non-finite or negative recommended microLamports';
    }
    return {
      pathLabel: args.path.pathLabel,
      mode: quote.mode,
      writableAccountsSampled: quote.writableAccountsSampled,
      observedSamples: quote.observedSamples,
      observedNonZeroSamples: quote.observedNonZeroSamples,
      recommendedMicroLamports: quote.recommendedMicroLamports,
      status,
      note,
    };
  } catch (err) {
    return {
      pathLabel: args.path.pathLabel,
      mode: 'error',
      writableAccountsSampled: 0,
      observedSamples: 0,
      observedNonZeroSamples: 0,
      recommendedMicroLamports: -1,
      status: args.required ? 'FAIL' : 'WARN',
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

async function validateJitoOnPath(args: {
  path: ValidationPath;
  connection: Connection;
  signer: Keypair;
  env: LandingEdgeEnv;
  strictJito: boolean;
  deps: LandingEdgeValidationDeps;
}): Promise<JitoValidationSummary> {
  const tipLamports = Math.max(0, Number(args.env.JITO_TIP_LAMPORTS ?? 0));
  let status: Status = 'PASS';
  let tipAccountsCount = 0;
  let tipFetchOk = false;
  let tipAdded = false;
  let compiled = false;
  let note: string | undefined;

  try {
    const tipAccounts = await args.deps.fetchJitoTipAccounts({
      bundlesUrl: args.env.JITO_BLOCK_ENGINE_BUNDLES_URL,
    });
    tipAccountsCount = tipAccounts.length;
    tipFetchOk = true;
    console.log(`[LandingEdgeValidation] jito tipAccountsFetched=${tipAccountsCount}`);
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
    status = args.strictJito ? 'FAIL' : 'WARN';
    console.warn(`[LandingEdgeValidation] jito tip account fetch failed: ${note}`);
  }

  if (tipFetchOk) {
    try {
      const rpcInstructions = await args.deps.withOptionalJitoTipInstruction({
        instructions: args.path.instructions,
        broadcast: true,
        sendMode: 'rpc',
        signer: args.signer.publicKey,
        tipLamports,
        bundlesUrl: args.env.JITO_BLOCK_ENGINE_BUNDLES_URL,
      });
      const jitoInstructions = await args.deps.withOptionalJitoTipInstruction({
        instructions: args.path.instructions,
        broadcast: true,
        sendMode: 'jito',
        signer: args.signer.publicKey,
        tipLamports,
        bundlesUrl: args.env.JITO_BLOCK_ENGINE_BUNDLES_URL,
      });
      const tipEval = verifyJitoTipMutation({
        baseInstructionCount: args.path.instructions.length,
        rpcInstructionCount: rpcInstructions.length,
        jitoInstructionCount: jitoInstructions.length,
        tipLamports,
        tipAccountsCount,
      });
      const transferProgramMatch =
        !tipEval.tipShouldBeAdded ||
        jitoInstructions[jitoInstructions.length - 1]?.programId.equals(SystemProgram.programId) === true;
      tipAdded = tipEval.tipShouldBeAdded && tipEval.jitoExpectedDeltaMatches;
      if (!tipEval.rpcUnchanged || !tipEval.jitoExpectedDeltaMatches || !transferProgramMatch) {
        status = 'FAIL';
        note = 'tip mutation expectation failed';
      } else {
        const latestBh = await args.connection.getLatestBlockhash();
        await args.deps.buildVersionedTx({
          payer: args.signer.publicKey,
          blockhash: latestBh.blockhash,
          instructions: jitoInstructions,
          lookupTables: args.path.lookupTables,
          signer: args.signer,
        });
        compiled = true;
      }
    } catch (err) {
      status = 'FAIL';
      note = err instanceof Error ? err.message : String(err);
    }
  }

  if (tipFetchOk && !compiled) {
    status = 'FAIL';
  }
  console.log(
    `[LandingEdgeValidation] jito path=${args.path.pathLabel} tipAccounts=${tipAccountsCount} tipAdded=${tipAdded} compiled=${compiled} sendModeEnv=${args.env.EXEC_SEND_MODE} bundleOnly=${args.env.JITO_BUNDLE_ONLY}`
  );

  return {
    status,
    pathLabel: args.path.pathLabel,
    tipAccountsCount,
    tipFetchOk,
    tipAdded,
    compiled,
    note,
  };
}

function foldFeeStatus(results: FeeQuoteSummary[], requiredPathLabel: string): Status {
  const required = results.find((r) => r.pathLabel === requiredPathLabel);
  if (!required || required.status === 'FAIL') {
    return 'FAIL';
  }
  if (required.status === 'WARN') {
    return 'WARN';
  }
  return results.some((r) => r.status === 'WARN') ? 'WARN' : 'PASS';
}

export async function runLandingEdgeValidationWithPlan(args: {
  cli: CliArgs;
  env: LandingEdgeEnv;
  connection: Connection;
  signer: Keypair;
  selectedPlan: FlashloanPlan;
  market: PublicKey;
  programId: PublicKey;
  deps?: Partial<LandingEdgeValidationDeps>;
}): Promise<LandingEdgeSummary> {
  const deps = { ...defaultDeps, ...(args.deps ?? {}) };
  const staticCuPrice = Number(process.env.EXEC_CU_PRICE ?? 0);
  const planKey = String(args.selectedPlan.key);

  const cooldownMap = new Map<string, KlendHealthyCooldownEntry>();
  const cooldownNowMs = DETERMINISTIC_TEST_TIMESTAMP_MS;
  const cooldownMs = Number(args.env.EXEC_KLEND_HEALTHY_COOLDOWN_MS);
  const anchorMs = getPlanCooldownAnchorMs(args.selectedPlan);
  setKlendHealthyCooldown(
    cooldownMap,
    planKey,
    anchorMs,
    cooldownNowMs,
    cooldownMs,
    DETERMINISTIC_TEST_HEALTH_RATIO
  );
  const cooldownSameAnchorBeforeExpiry = !!shouldSkipForKlendHealthyCooldown(
    cooldownMap,
    planKey,
    anchorMs,
    cooldownNowMs + Math.max(1, cooldownMs - 1)
  );
  const cooldownAnchorChangeInvalidates = !shouldSkipForKlendHealthyCooldown(
    cooldownMap,
    planKey,
    anchorMs + 1,
    cooldownNowMs + 1
  );
  const cooldownAfterExpiryClears = !shouldSkipForKlendHealthyCooldown(
    cooldownMap,
    planKey,
    anchorMs,
    cooldownNowMs + cooldownMs + 1
  );
  console.log(
    `[LandingEdgeValidation] cooldown.sameAnchorBeforeExpiry=${cooldownSameAnchorBeforeExpiry ? 'PASS' : 'FAIL'}`
  );
  console.log(
    `[LandingEdgeValidation] cooldown.anchorChangeInvalidates=${cooldownAnchorChangeInvalidates ? 'PASS' : 'FAIL'}`
  );
  console.log(
    `[LandingEdgeValidation] cooldown.afterExpiryClears=${cooldownAfterExpiryClears ? 'PASS' : 'FAIL'}`
  );
  const cooldownStatus: Status =
    cooldownSameAnchorBeforeExpiry && cooldownAnchorChangeInvalidates && cooldownAfterExpiryClears ? 'PASS' : 'FAIL';

  const preBuild = await deps.buildPreLiquidationValidationPath({
    connection: args.connection,
    plan: args.selectedPlan,
    feePayer: args.signer.publicKey,
  });
  const prePath: ValidationPath = {
    pathLabel: preBuild.source,
    instructions: preBuild.instructions,
    labels: preBuild.labels,
    lookupTables: preBuild.lookupTables,
  };

  const feeResults: FeeQuoteSummary[] = [];
  feeResults.push(
    await quoteFeeForPath({
      path: prePath,
      connection: args.connection,
      signer: args.signer,
      env: args.env,
      staticCuPrice,
      strictRecentFees: args.cli.strictRecentFees,
      required: true,
      deps,
    })
  );

  const jitoResult = await validateJitoOnPath({
    path: prePath,
    connection: args.connection,
    signer: args.signer,
    env: args.env,
    strictJito: args.cli.strictJito,
    deps,
  });

  let fullBuildStatus: Status = 'PASS';
  let fullBuildReason: string | undefined;
  try {
    const built = await deps.buildPlanTransactions({
      connection: args.connection,
      signer: args.signer,
      market: args.market,
      programId: args.programId,
      plan: args.selectedPlan,
      includeSwap: false,
      useRealSwapSizing: false,
      dry: true,
    });
    const fullPaths = extractValidationPaths(built);
    for (const fullPath of fullPaths) {
      feeResults.push(
        await quoteFeeForPath({
          path: fullPath,
          connection: args.connection,
          signer: args.signer,
          env: args.env,
          staticCuPrice,
          strictRecentFees: args.cli.strictRecentFees,
          required: false,
          deps,
        })
      );
    }
    fullBuildStatus = 'PASS';
    console.log('[LandingEdgeValidation] fullBuildStatus=PASS');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isOrdinaryFullBuildFailure(msg)) {
      fullBuildStatus = 'WARN';
      fullBuildReason = msg;
      console.warn(`[LandingEdgeValidation] fullBuildStatus=WARN reason=${msg}`);
    } else {
      fullBuildStatus = 'FAIL';
      fullBuildReason = msg;
      console.error(`[LandingEdgeValidation] fullBuildStatus=FAIL reason=${msg}`);
    }
  }

  const feesStatus = foldFeeStatus(feeResults, prePath.pathLabel);
  const jitoStatus = jitoResult.status;
  const overall: Status =
    cooldownStatus === 'FAIL' || feesStatus === 'FAIL' || jitoStatus === 'FAIL' || fullBuildStatus === 'FAIL'
      ? 'FAIL'
      : feesStatus === 'WARN' || jitoStatus === 'WARN' || fullBuildStatus === 'WARN'
      ? 'WARN'
      : 'PASS';

  const summary: LandingEdgeSummary = {
    selectedPlanKey: planKey,
    cooldown: cooldownStatus,
    fees: feesStatus,
    jito: jitoStatus,
    fullBuild: fullBuildStatus,
    fullBuildReason,
    overall,
    pathLabels: feeResults.map((r) => r.pathLabel),
    feeResults,
    jitoResult,
    cooldownChecks: {
      sameAnchorBeforeExpiry: cooldownSameAnchorBeforeExpiry,
      anchorChangeInvalidates: cooldownAnchorChangeInvalidates,
      afterExpiryClears: cooldownAfterExpiryClears,
    },
  };

  console.log(
    `[LandingEdgeValidation] SUMMARY cooldown=${summary.cooldown} fees=${summary.fees} jito=${summary.jito} fullBuild=${summary.fullBuild} overall=${summary.overall}`
  );

  return summary;
}

export async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const env = loadEnv();
  const connection = getConnection();
  const signer = loadSigner(env.BOT_KEYPAIR_PATH);
  const market = new PublicKey(env.KAMINO_MARKET_PUBKEY);
  const programId = new PublicKey(env.KAMINO_KLEND_PROGRAM_ID);

  const queuePlans = loadQueuePlans();
  const selectedPlan =
    (cli.planKey ? queuePlans.find((plan) => String(plan.key) === String(cli.planKey)) : queuePlans[0]) ?? queuePlans[0];
  if (!selectedPlan) {
    throw new Error('No selectable plan from tx_queue.json');
  }
  if (cli.planKey && String(selectedPlan.key) !== String(cli.planKey)) {
    throw new Error(`Requested --plan-key not found: ${cli.planKey}`);
  }
  console.log(`[LandingEdgeValidation] selected plan key=${selectedPlan.key}`);

  const summary = await runLandingEdgeValidationWithPlan({
    cli,
    env,
    connection,
    signer,
    selectedPlan,
    market,
    programId,
  });

  if (cli.json) {
    console.log(
      JSON.stringify(
        {
          selectedPlanKey: summary.selectedPlanKey,
          cooldown: summary.cooldown,
          fees: summary.fees,
          jito: summary.jito,
          fullBuild: summary.fullBuild,
          fullBuildReason: summary.fullBuildReason,
          overall: summary.overall,
        },
        null,
        2
      )
    );
  }

  if (summary.overall === 'FAIL') {
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[LandingEdgeValidation] FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

