import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { getConnection } from "../solana/connection.js";
import { loadEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { buildKaminoFlashloanIxs, type FlashloanMint } from "../flashloan/kaminoFlashloan.js";
import { buildComputeBudgetIxs } from "../execution/computeBudget.js";
import { MEMO_PROGRAM_ID } from "../constants/programs.js";
import { SOL_MINT, USDC_MINT } from "../constants/mints.js";
import { scoreHazard } from "../predict/hazardScorer.js";
import { computeEV, type EvParams } from "../predict/evCalculator.js";
import { estimateTtlString } from "../predict/ttlEstimator.js";

/**
 * Normalize any candidates payload into an array.
 * Supports: array, {data: [...]}, {candidates: [...]}, keyed object.
 */
function normalizeCandidates(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.candidates)) return payload.candidates;
  return Object.values(payload);
}

/**
 * Load candidates with forecast scores from data/candidates.scored.json
 * Returns null if file doesn't exist
 */
function loadCandidatesScored(): any | null {
  const p = path.join(process.cwd(), 'data', 'candidates.scored.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Load raw candidates from data/candidates.json
 * Throws if file doesn't exist
 */
function loadCandidatesRaw(): any {
  const p = path.join(process.cwd(), 'data', 'candidates.json');
  if (!fs.existsSync(p)) {
    throw new Error('Missing data/candidates.json. Run: npm run snapshot:candidates:wsl');
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Parse TTL string (e.g., "5m30s") into minutes
 * Returns Infinity for unknown or invalid values
 */
function parseTtlMinutes(ttlStr: string): number {
  if (!ttlStr || ttlStr === 'unknown') return Infinity;
  const m = /^(\d+)m(\d+)s$/.exec(ttlStr);
  if (!m) return Infinity;
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);
  return minutes + seconds / 60;
}

/**
 * Helper function to get token balance in UI units
 */
async function getTokenUiBalance(connection: Connection, ata: PublicKey): Promise<number> {
  try {
    const balance = await connection.getTokenAccountBalance(ata);
    return parseFloat(balance.value.uiAmountString || "0");
  } catch {
    // If ATA doesn't exist yet, return 0
    return 0;
  }
}

function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("Keypair file must be a JSON array");
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function createPlaceholderInstruction(signer: PublicKey): TransactionInstruction {
  // Create a simple memo instruction as placeholder
  // This simulates where liquidation + swap instructions would go
  const message = "PR9 flashloan placeholder";
  
  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(message, "utf8"),
  });
}

async function main() {
  // Parse command line args
  const args = process.argv.slice(2);
  const mintArg = args.find((_arg, i) => args[i - 1] === "--mint")?.toUpperCase();
  const amountArg = args.find((_arg, i) => args[i - 1] === "--amount");
  const feeBufferArg = args.find((_arg, i) => args[i - 1] === "--fee-buffer-ui");

  const mint = (mintArg || "USDC") as FlashloanMint;
  const amount = amountArg || "1000";
  // Parse fee buffer or use defaults: USDC → 1.0, SOL → 0.01
  let requiredFeeBufferUi: number;
  if (feeBufferArg) {
    requiredFeeBufferUi = parseFloat(feeBufferArg);
    if (isNaN(requiredFeeBufferUi) || requiredFeeBufferUi < 0) {
      throw new Error(`Invalid --fee-buffer-ui: ${feeBufferArg}. Must be a non-negative number.`);
    }
  } else {
    requiredFeeBufferUi = mint === "SOL" ? 0.01 : 1.0;
  }

  // Validate mint
  if (mint !== "SOL" && mint !== "USDC") {
    throw new Error(`Invalid mint: ${mint}. Must be SOL or USDC`);
  }

  logger.info(
    { event: "flashloan_dryrun_start", mint, amount, requiredFeeBufferUi },
    "Starting Kamino flashloan dry-run"
  );

  // Load environment
  const env = loadEnv();
  
  // Setup connection and signer
  const connection = getConnection();
  const signer = loadKeypair(env.BOT_KEYPAIR_PATH);
  
  logger.info(
    { event: "config_loaded", signer: signer.publicKey.toBase58(), rpc: env.RPC_PRIMARY },
    "Configuration loaded"
  );

  // PR 8.7: Forecast-aware candidate ranking
  const useForecast = env.USE_FORECAST_FOR_DRYRUN === 'true';
  
  // Load payload (object or array), then normalize to array
  const scoredPayload = loadCandidatesScored();
  const rawPayload = scoredPayload ?? loadCandidatesRaw();
  let candidates = normalizeCandidates(rawPayload);

  logger.info(
    {
      event: "forecast_candidates_loaded",
      source: scoredPayload ? "scored" : "raw",
      isArray: Array.isArray(rawPayload),
      normalizedCount: candidates.length,
    },
    "Loaded forecast candidates"
  );

  let ranked: any[] = candidates;
  let target: any;

  if (useForecast) {
    logger.info({ event: "forecast_ranking_enabled" }, "Forecast ranking enabled for dry-run");
    
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error("No candidates available (empty or invalid candidates payload)");
    }

    // Compute on the fly if forecast fields are missing
    const alpha = Number(env.HAZARD_ALPHA ?? 25);
    const evParams: EvParams = {
      closeFactor: Number(env.EV_CLOSE_FACTOR ?? 0.5),
      liquidationBonusPct: Number(env.EV_LIQUIDATION_BONUS_PCT ?? 0.05),
      flashloanFeePct: Number(env.EV_FLASHLOAN_FEE_PCT ?? 0.002),
      fixedGasUsd: Number(env.EV_FIXED_GAS_USD ?? 0.5),
      slippageBufferPct: env.EV_SLIPPAGE_BUFFER_PCT ? Number(env.EV_SLIPPAGE_BUFFER_PCT) : undefined,
    };
    const solDropPctPerMin = Number(env.TTL_SOL_DROP_PCT_PER_MIN ?? 0.2);
    const maxDropPct = Number(env.TTL_MAX_DROP_PCT ?? 20);

    ranked = candidates.map((c: any) => {
      const hr = Number(c.healthRatioRaw ?? c.healthRatio ?? 0);
      const hazard = c.hazard ?? scoreHazard(hr, alpha);
      const borrow = Number(c.borrowValueUsd ?? 0);
      const ev = c.ev ?? computeEV(borrow, hazard, evParams);
      const ttlStr = (c.forecast?.timeToLiquidation) ?? estimateTtlString(c, { solDropPctPerMin, maxDropPct });
      const ttlMin = parseTtlMinutes(ttlStr);
      return { ...c, key: c.key ?? c.obligationPubkey ?? 'unknown', hazard, ev, ttlMin, ttlStr };
    }).sort((a: any, b: any) => {
      if (b.ev !== a.ev) return Number(b.ev) - Number(a.ev);
      if (a.ttlMin !== b.ttlMin) return Number(a.ttlMin) - Number(b.ttlMin);
      return Number(b.hazard) - Number(a.hazard);
    });

    // Log top 10 ranked
    logger.info({ event: "forecast_ranking_complete", totalCandidates: ranked.length }, "Ranking complete");
    console.log("\n📊 Top 10 Ranked Candidates by EV/TTL/Hazard:");
    console.table(ranked.slice(0, 10).map((x: any) => ({
      key: x.key,
      healthRatio: Number(x.healthRatioRaw ?? x.healthRatio ?? 0).toFixed(4),
      hazard: Number(x.hazard).toFixed(4),
      ev: Number(x.ev).toFixed(4),
      ttl: x.ttlStr,
      borrowValueUsd: Number(x.borrowValueUsd ?? 0).toFixed(2),
    })));

    target = ranked[0];
    if (!target) {
      throw new Error('No candidates available for dry-run after ranking');
    }
    
    logger.info(
      { 
        event: "target_selected",
        key: target.key,
        ev: target.ev,
        ttl: target.ttlStr,
        hazard: target.hazard
      },
      "Top-ranked candidate selected for simulation"
    );
  } else {
    logger.info({ event: "forecast_ranking_disabled" }, "Forecast ranking disabled, using baseline selection");
    target = candidates[0];
    if (!target) {
      throw new Error('No candidates available for dry-run');
    }
  }


  // Preflight: payer must exist on-chain and have lamports
  const payerInfo = await connection.getAccountInfo(signer.publicKey);
  if (!payerInfo) {
    throw new Error(
      `Fee payer account ${signer.publicKey.toBase58()} does not exist on-chain yet. ` +
      `Send some SOL to this address (e.g. 0.05 SOL) then retry.`
    );
  }

  if (payerInfo.lamports === 0) {
    throw new Error(
      `Fee payer account ${signer.publicKey.toBase58()} has 0 lamports. ` +
      `Fund it with SOL for transaction fees then retry.`
    );
  }

  // Build compute budget instructions
  const computeBudgetIxs = buildComputeBudgetIxs({ cuLimit: 600_000, cuPriceMicroLamports: 0 });
  
  logger.info({ event: "compute_budget_ixs", count: computeBudgetIxs.length }, "Compute budget instructions built");

  // Pass 1: Build flashloan assuming no preIxs
  let borrowIxIndex = computeBudgetIxs.length;
  
  logger.info(
    { event: "building_flashloan_pass1", borrowIxIndex, mint, amount },
    "Building flashloan instructions (pass 1)"
  );

  let built = await buildKaminoFlashloanIxs({
    connection,
    marketPubkey: new PublicKey(env.KAMINO_MARKET_PUBKEY),
    programId: new PublicKey(env.KAMINO_KLEND_PROGRAM_ID),
    signer,
    mint,
    amountUi: amount,
    borrowIxIndex,
  });

  // Idempotent ATA create if missing
  const preIxs: TransactionInstruction[] = [];
  const ataInfo = await connection.getAccountInfo(built.destinationAta);
  
  if (!ataInfo) {
    logger.info(
      { event: "ata_missing", ata: built.destinationAta.toBase58() },
      "Destination ATA does not exist, creating idempotent instruction"
    );
    
    // Determine mint pubkey based on mint type
    let mintPubkey: PublicKey;
    if (mint === "USDC") {
      mintPubkey = new PublicKey(USDC_MINT);
    } else if (mint === "SOL") {
      mintPubkey = new PublicKey(SOL_MINT);
    } else {
      // This should never happen due to type checking, but guard against it
      throw new Error(`Unsupported mint type: ${mint}`);
    }
    
    preIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,               // payer
        built.destinationAta,           // ATA address
        signer.publicKey,               // owner
        mintPubkey,                     // mint
        built.tokenProgramId,           // token program (Token or Token-2022) from SDK
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    // Pass 2: recompute borrowIxIndex and rebuild flashloan with correct index
    borrowIxIndex = computeBudgetIxs.length + preIxs.length;
    
    logger.info(
      { event: "building_flashloan_pass2", borrowIxIndex },
      "Rebuilding flashloan with adjusted borrowIxIndex (pass 2)"
    );
    
    built = await buildKaminoFlashloanIxs({
      connection,
      marketPubkey: new PublicKey(env.KAMINO_MARKET_PUBKEY),
      programId: new PublicKey(env.KAMINO_KLEND_PROGRAM_ID),
      signer,
      mint,
      amountUi: amount,
      borrowIxIndex,
    });
  } else {
    logger.info(
      { event: "ata_exists", ata: built.destinationAta.toBase58() },
      "Destination ATA already exists"
    );
  }

  const { destinationAta, tokenProgramId, flashBorrowIx, flashRepayIx } = built;

  logger.info(
    { 
      event: "flashloan_built", 
      destinationAta: destinationAta.toBase58(),
      tokenProgramId: tokenProgramId.toBase58(),
      preIxsCount: preIxs.length
    },
    "Flashloan instructions built"
  );

  // Fee buffer precheck: ensure destination ATA has sufficient balance
  const currentUi = await getTokenUiBalance(connection, destinationAta);
  logger.info(
    { event: "fee_buffer_check", currentUi, requiredFeeBufferUi, destinationAta: destinationAta.toBase58() },
    "Checking fee buffer requirement"
  );

  if (currentUi < requiredFeeBufferUi) {
    const mintName = mint === "SOL" ? "SOL (wrapped SOL)" : mint;
    // Shortfall is always positive here since currentUi < requiredFeeBufferUi
    const shortfall = requiredFeeBufferUi - currentUi;
    
    throw new Error(
      `Insufficient fee buffer in destination ATA.\n` +
      `  Destination ATA: ${destinationAta.toBase58()}\n` +
      `  Mint: ${mintName}\n` +
      `  Current balance: ${currentUi} ${mint}\n` +
      `  Required buffer: ${requiredFeeBufferUi} ${mint}\n` +
      `  Shortfall: ${shortfall} ${mint}\n\n` +
      `Action required: Transfer at least ${requiredFeeBufferUi} ${mint} to the destination ATA before running this command.\n` +
      `You can override the default buffer with --fee-buffer-ui <amount>.`
    );
  }

  logger.info(
    { event: "fee_buffer_ok", currentUi, requiredFeeBufferUi },
    "Fee buffer requirement satisfied"
  );

  // Create placeholder instruction
  const placeholderIx = createPlaceholderInstruction(signer.publicKey);

  // Build transaction with correct instruction order:
  // 1. Compute budget instructions
  // 2. Pre-instructions (ATA creation if needed)
  // 3. Flash borrow (at borrowIxIndex)
  // 4. Placeholder (where liquidation + swap would go)
  // 5. Flash repay
  const transaction = new Transaction();

  if (computeBudgetIxs.length > 0) {
    transaction.add(...computeBudgetIxs);
  }

  if (preIxs.length > 0) {
    transaction.add(...preIxs); // ensure ATA exists before borrow
  }

  transaction.add(flashBorrowIx);
  transaction.add(placeholderIx);
  transaction.add(flashRepayIx);

  // Set recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = signer.publicKey;

  logger.info(
    { event: "transaction_built", instructionCount: transaction.instructions.length },
    "Transaction built, simulating..."
  );

  // Preflight: check all accounts exist before simulation
  function collectTxPubkeys(ixs: TransactionInstruction[]): PublicKey[] {
    const map = new Map<string, PublicKey>();
    for (const ix of ixs) {
      map.set(ix.programId.toBase58(), ix.programId);
      for (const k of ix.keys) map.set(k.pubkey.toBase58(), k.pubkey);
    }
    return [...map.values()];
  }

  const allKeys = collectTxPubkeys(transaction.instructions);
  const infos = await connection.getMultipleAccountsInfo(allKeys);

  // Build ignored set: Instructions Sysvar + destination ATA if created in-tx
  const ignored = new Set<string>();
  ignored.add(SYSVAR_INSTRUCTIONS_PUBKEY.toBase58());
  if (preIxs.length > 0) {
    ignored.add(destinationAta.toBase58());
  }

  const missing = allKeys
    .map((k, i) => ({ k, info: infos[i] }))
    .filter((x) => x.info === null && !ignored.has(x.k.toBase58()))
    .map((x) => x.k.toBase58());

  if (missing.length) {
    logger.error(
      { event: "preflight_missing_accounts", missing, total: allKeys.length },
      "Some accounts referenced by the transaction do not exist on-chain"
    );

    throw new Error(
      `Preflight failed: missing ${missing.length} account(s). First missing: ${missing[0]}`
    );
  }

  // Simulate transaction
  const simulation = await connection.simulateTransaction(transaction, [signer]);

  if (simulation.value.err) {
    logger.error(
      { event: "simulation_failed", error: simulation.value.err, logs: simulation.value.logs },
      "Simulation failed"
    );
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  const unitsConsumed = simulation.value.unitsConsumed || 0;
  const logs = simulation.value.logs || [];

  logger.info(
    {
      event: "simulation_success",
      unitsConsumed,
      logsCount: logs.length,
    },
    "Simulation succeeded"
  );

  // Print summary
  console.log("\n✅ Flashloan Dry-Run Successful!");
  console.log(`   Mint: ${mint}`);
  console.log(`   Amount: ${amount}`);
  console.log(`   Compute Units Consumed: ${unitsConsumed}`);
  console.log(`   Instructions: ${transaction.instructions.length}`);
  console.log(`   Destination ATA: ${destinationAta.toBase58()}`);
  console.log(`   Token Program: ${tokenProgramId.toBase58()}`);
  console.log("\nSimulation Logs:");
  logs.forEach((log, i) => {
    console.log(`   [${i}] ${log}`);
  });

  // Validate logs contain expected Kamino program invocations (deterministic check)
  const kaminoProgramId = env.KAMINO_KLEND_PROGRAM_ID;
  const invokeCount = logs.filter((log) => log.includes(`Program ${kaminoProgramId} invoke`)).length;

  if (invokeCount < 2) {
    logger.warn(
      { event: "missing_invocations", invokeCount, expected: ">=2" },
      `Expected >=2 Kamino program invocations (borrow+repay), got ${invokeCount}`
    );
  } else {
    logger.info(
      { event: "invocations_verified", invokeCount },
      "Kamino flashloan invocations verified in logs"
    );
  }
}

main().catch((err) => {
  logger.fatal({ event: "flashloan_dryrun_failed", err }, "Flashloan dry-run failed");
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
