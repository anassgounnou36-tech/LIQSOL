import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import { loadEnv } from '../config/env.js';
import { normalizeWslPath } from '../utils/path.js';
import { getConnection } from '../solana/connection.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';
import { buildPlanTransactions } from '../execute/planTxBuilder.js';
import { extractValidationPaths, pickPrimaryValidationPath, evaluateJitoTipMutation } from '../execute/landingEdgeValidation.js';
import { getPlanCooldownAnchorMs, setKlendHealthyCooldown, shouldSkipForKlendHealthyCooldown, type KlendHealthyCooldownEntry } from '../execute/klendHealthyCooldown.js';
import { quotePriorityFeeMicroLamports } from '../execute/priorityFeePolicy.js';
import { fetchJitoTipAccounts } from '../execute/jitoSender.js';
import { withOptionalJitoTipInstruction } from '../execute/executor.js';
import { buildVersionedTx } from '../execute/versionedTx.js';

type Status = 'PASS' | 'WARN' | 'FAIL';

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

function parseCliArgs(args: string[]) {
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

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const env = loadEnv();
  const connection = getConnection();
  const signer = loadSigner(env.BOT_KEYPAIR_PATH);
  const market = new PublicKey(env.KAMINO_MARKET_PUBKEY);
  const programId = new PublicKey(env.KAMINO_KLEND_PROGRAM_ID);

  const queuePlans = loadQueuePlans();
  const selectedPlan =
    (args.planKey
      ? queuePlans.find((plan) => String(plan.key) === String(args.planKey))
      : queuePlans[0]) ?? queuePlans[0];
  if (!selectedPlan) {
    throw new Error('No selectable plan from tx_queue.json');
  }
  if (args.planKey && String(selectedPlan.key) !== String(args.planKey)) {
    throw new Error(`Requested --plan-key not found: ${args.planKey}`);
  }

  console.log(`[LandingEdgeValidation] selected plan key=${selectedPlan.key}`);
  const built = await buildPlanTransactions({
    connection,
    signer,
    market,
    programId,
    plan: selectedPlan,
    includeSwap: false,
    useRealSwapSizing: false,
    dry: true,
  });
  const paths = extractValidationPaths(built);
  if (paths.length === 0) {
    throw new Error('No validation paths were produced by buildPlanTransactions');
  }
  const primaryPath = pickPrimaryValidationPath(paths);
  if (!primaryPath) {
    throw new Error('No primary validation path selected');
  }

  const cooldownMap = new Map<string, KlendHealthyCooldownEntry>();
  const cooldownNowMs = 1_000_000;
  const cooldownMs = Number(env.EXEC_KLEND_HEALTHY_COOLDOWN_MS);
  const planKey = String(selectedPlan.key);
  const anchorMs = getPlanCooldownAnchorMs(selectedPlan);
  setKlendHealthyCooldown(cooldownMap, planKey, anchorMs, cooldownNowMs, cooldownMs, 1.012345);
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

  const feeResults: FeeQuoteSummary[] = [];
  let feeStatus: Status = 'FAIL';
  let feeQuotedCount = 0;
  let feeWarnSeen = false;
  for (const pathEntry of paths) {
    try {
      const quote = await quotePriorityFeeMicroLamports({
        connection,
        instructions: pathEntry.instructions,
        payer: signer.publicKey,
        staticMicroLamports: Number(process.env.EXEC_CU_PRICE ?? 0),
        mode: env.EXEC_PRIORITY_FEE_MODE,
        percentile: Number(env.EXEC_PRIORITY_FEE_PERCENTILE),
        floorMicroLamports: Number(env.EXEC_PRIORITY_FEE_FLOOR_MICROLAMPORTS),
        capMicroLamports: Number(env.EXEC_PRIORITY_FEE_CAP_MICROLAMPORTS),
        maxAccounts: Number(env.EXEC_PRIORITY_FEE_SAMPLE_ACCOUNTS_LIMIT),
      });
      console.log(
        `[LandingEdgeValidation] priority-fee path=${pathEntry.pathLabel} mode=${quote.mode} writableAccounts=${quote.writableAccountsSampled} samples=${quote.observedSamples} nonZeroSamples=${quote.observedNonZeroSamples} microLamports=${quote.recommendedMicroLamports}`
      );
      let status: Status = 'PASS';
      let note: string | undefined;
      if (
        env.EXEC_PRIORITY_FEE_MODE === 'recent-fees' &&
        (quote.mode === 'static' || quote.observedSamples === 0)
      ) {
        status = args.strictRecentFees ? 'FAIL' : 'WARN';
        note = 'recent-fees fallback detected';
      }
      if (status === 'WARN') feeWarnSeen = true;
      if (status === 'FAIL') feeStatus = 'FAIL';
      if (Number.isFinite(quote.recommendedMicroLamports) && quote.recommendedMicroLamports >= 0) {
        feeQuotedCount++;
      }
      feeResults.push({
        pathLabel: pathEntry.pathLabel,
        mode: quote.mode,
        writableAccountsSampled: quote.writableAccountsSampled,
        observedSamples: quote.observedSamples,
        observedNonZeroSamples: quote.observedNonZeroSamples,
        recommendedMicroLamports: quote.recommendedMicroLamports,
        status,
        note,
      });
    } catch (err) {
      feeResults.push({
        pathLabel: pathEntry.pathLabel,
        mode: 'error',
        writableAccountsSampled: 0,
        observedSamples: 0,
        observedNonZeroSamples: 0,
        recommendedMicroLamports: -1,
        status: 'FAIL',
        note: err instanceof Error ? err.message : String(err),
      });
      feeStatus = 'FAIL';
    }
  }
  if (feeStatus !== 'FAIL') {
    if (feeQuotedCount === 0) {
      feeStatus = 'FAIL';
    } else {
      feeStatus = feeWarnSeen ? 'WARN' : 'PASS';
    }
  }

  const tipLamports = Math.max(0, Number(env.JITO_TIP_LAMPORTS ?? 0));
  let jitoStatus: Status = 'PASS';
  let tipAccountsCount = 0;
  let tipFetchOk = false;
  let tipAdded = false;
  let compiled = false;
  let jitoNote: string | undefined;
  let rpcInstructions: TransactionInstruction[] = primaryPath.instructions;
  let jitoInstructions: TransactionInstruction[] = primaryPath.instructions;
  try {
    const tipAccounts = await fetchJitoTipAccounts({
      bundlesUrl: env.JITO_BLOCK_ENGINE_BUNDLES_URL,
    });
    tipAccountsCount = tipAccounts.length;
    tipFetchOk = true;
    console.log(`[LandingEdgeValidation] jito tipAccountsFetched=${tipAccountsCount}`);
  } catch (err) {
    jitoNote = err instanceof Error ? err.message : String(err);
    jitoStatus = args.strictJito ? 'FAIL' : 'WARN';
    console.warn(`[LandingEdgeValidation] jito tip account fetch failed: ${jitoNote}`);
  }

  if (tipFetchOk) {
    try {
      rpcInstructions = await withOptionalJitoTipInstruction({
        instructions: primaryPath.instructions,
        broadcast: true,
        sendMode: 'rpc',
        signer: signer.publicKey,
        tipLamports,
        bundlesUrl: env.JITO_BLOCK_ENGINE_BUNDLES_URL,
      });
      jitoInstructions = await withOptionalJitoTipInstruction({
        instructions: primaryPath.instructions,
        broadcast: true,
        sendMode: 'jito',
        signer: signer.publicKey,
        tipLamports,
        bundlesUrl: env.JITO_BLOCK_ENGINE_BUNDLES_URL,
      });
      const tipEval = evaluateJitoTipMutation({
        baseInstructionCount: primaryPath.instructions.length,
        rpcInstructionCount: rpcInstructions.length,
        jitoInstructionCount: jitoInstructions.length,
        tipLamports,
        tipAccountsCount,
      });
      const transferProgramMatch =
        !tipEval.tipShouldBeAdded ||
        jitoInstructions[jitoInstructions.length - 1]?.programId.equals(SystemProgram.programId) === true;
      tipAdded = tipEval.tipShouldBeAdded && jitoInstructions.length === primaryPath.instructions.length + 1;
      if (!tipEval.rpcUnchanged || !tipEval.jitoExpectedDeltaMatches || !transferProgramMatch) {
        jitoStatus = 'FAIL';
        jitoNote = 'tip mutation expectation failed';
      } else {
        const latestBh = await connection.getLatestBlockhash();
        await buildVersionedTx({
          payer: signer.publicKey,
          blockhash: latestBh.blockhash,
          instructions: jitoInstructions,
          lookupTables: primaryPath.lookupTables,
          signer,
        });
        compiled = true;
      }
    } catch (err) {
      jitoStatus = 'FAIL';
      jitoNote = err instanceof Error ? err.message : String(err);
    }
  }

  if (tipFetchOk && !compiled) {
    jitoStatus = 'FAIL';
  }
  console.log(
    `[LandingEdgeValidation] jito path=${primaryPath.pathLabel} tipAccounts=${tipAccountsCount} tipAdded=${tipAdded} compiled=${compiled} sendModeEnv=${env.EXEC_SEND_MODE} bundleOnly=${env.JITO_BUNDLE_ONLY}`
  );

  const overall: Status =
    cooldownStatus === 'FAIL' || feeStatus === 'FAIL' || jitoStatus === 'FAIL'
      ? 'FAIL'
      : feeStatus === 'WARN' || jitoStatus === 'WARN'
      ? 'WARN'
      : 'PASS';
  console.log(
    `[LandingEdgeValidation] SUMMARY cooldown=${cooldownStatus} fees=${feeStatus} jito=${jitoStatus} overall=${overall}`
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          planKey,
          pathLabels: paths.map((p) => p.pathLabel),
          cooldown: {
            sameAnchorBeforeExpiry: cooldownSameAnchorBeforeExpiry,
            anchorChangeInvalidates: cooldownAnchorChangeInvalidates,
            afterExpiryClears: cooldownAfterExpiryClears,
            status: cooldownStatus,
          },
          fees: {
            status: feeStatus,
            results: feeResults,
          },
          jito: {
            status: jitoStatus,
            pathLabel: primaryPath.pathLabel,
            tipAccountsCount,
            tipFetchOk,
            tipAdded,
            compiled,
            note: jitoNote,
          },
          overall,
        },
        null,
        2
      )
    );
  }

  if (overall === 'FAIL') {
    process.exit(1);
  }
}

const isDirectRun =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  main().catch((err) => {
    console.error(`[LandingEdgeValidation] FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
