import fs from 'node:fs';
import path from 'node:path';
import { AddressLookupTableAccount, Keypair, VersionedTransaction, TransactionMessage, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getConnection } from '../solana/connection.js';
import { loadEnv } from '../config/env.js';
import { normalizeWslPath } from '../utils/path.js';
import { sendWithBoundedRetry, sendWithRebuildRetry, formatAttemptResults } from './broadcastRetry.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';
import { isPlanComplete, getMissingFields } from '../scheduler/planValidation.js';
import { validateCompiledInstructionWindow, decodeCompiledInstructionKinds } from '../kamino/canonicalLiquidationIxs.js';
import { downgradeBlockedPlan, dropPlanFromQueue } from '../scheduler/txScheduler.js';
import { isBlocked, markAtaCreated, markBlocked } from '../state/setupState.js';
import { buildPlanTransactions } from './planTxBuilder.js';
import { buildVersionedTx } from './versionedTx.js';
import { buildComputeBudgetIxs } from '../execution/computeBudget.js';
import { Presubmitter } from '../presubmit/presubmitter.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const ATA_ACCOUNT_SIZE = 165;
const SETUP_FEE_BUFFER_LAMPORTS = 2_000_000;
let lastUnderfundedWarnMs = 0;
let startupFeePayerCheckDone = false;
let cachedAtaRentLamports: number | undefined;
const dryRunSetupRequiredCache = new Map<string, number>();
const obligationHealthyCooldown = new Map<string, number>(); // planKey -> untilMs
let presubmitterSingleton: Presubmitter | undefined;

function dumpCompiledIxAccounts(opts: {
  tx: VersionedTransaction;
  ixIndex: number;
  label?: string;
}) {
  const dbg = process.env.DEBUG_REFRESH_OBLIGATION === '1';
  if (!dbg) return;

  const msg: any = opts.tx.message;
  const compiled = msg.compiledInstructions?.[opts.ixIndex];
  if (!compiled) {
    console.error(`[Executor][DEBUG_REFRESH_OBLIGATION] No compiled instruction at index=${opts.ixIndex}`);
    return;
  }

  const keys = msg.staticAccountKeys as PublicKey[];
  const programId = keys[compiled.programIdIndex]?.toBase58?.() ?? 'unknown';
  console.error(`\n[Executor][DEBUG_REFRESH_OBLIGATION] Compiled ix accounts dump index=${opts.ixIndex} label=${opts.label ?? 'unknown'}`);
  console.error(`[Executor][DEBUG_REFRESH_OBLIGATION] programId=${programId}`);
  console.error(`[Executor][DEBUG_REFRESH_OBLIGATION] accounts (${compiled.accountKeyIndexes.length}):`);
  compiled.accountKeyIndexes.forEach((k: number, i: number) => {
    const pk = keys[k];
    console.error(`  [${i}] ${pk ? pk.toBase58() : `missingKeyIndex(${k})`}`);
  });
  console.error('');
}

function extractCustomCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object' || !('InstructionError' in err)) return undefined;
  const instructionError = (err as { InstructionError?: unknown }).InstructionError as unknown[] | undefined;
  const innerError = instructionError?.[1];
  if (innerError && typeof innerError === 'object' && 'Custom' in innerError) {
    return (innerError as { Custom?: number }).Custom;
  }
  return undefined;
}

function shouldFallbackToSetupOnly(simErr: unknown, logs: string[] | undefined): boolean {
  const customCode = extractCustomCode(simErr);
  if (customCode === 6032) return true;
  if (!logs || logs.length === 0) return false;
  return logs.some((l) => /NoFlashRepayFound|missing swap/i.test(l));
}

function withUpdatedComputeBudget(
  instructions: TransactionInstruction[],
  labels: string[],
  cuLimit: number,
  cuPrice: number
): { instructions: TransactionInstruction[]; labels: string[] } {
  const start = labels.findIndex((l) => l.startsWith('computeBudget:'));
  if (start < 0) return { instructions, labels };
  let end = start;
  while (end < labels.length && labels[end].startsWith('computeBudget:')) end++;
  const computeIxs = buildComputeBudgetIxs({ cuLimit, cuPriceMicroLamports: cuPrice });
  const computeLabels = ['computeBudget:limit', ...(computeIxs.length > 1 ? ['computeBudget:price'] : [])];
  return {
    instructions: [...instructions.slice(0, start), ...computeIxs, ...instructions.slice(end)],
    labels: [...labels.slice(0, start), ...computeLabels, ...labels.slice(end)],
  };
}

interface Plan {
  planVersion?: number;
  key: string;
  obligationPubkey?: string;
  mint?: string;
  amountUi?: string;
  amountUsd?: string | number; // Can be string or number
  ev?: number | string;
  hazard?: number | string;
  ttlStr?: string;
  ttlMin?: number | string | null; // Can be null for unknown
  predictedLiquidationAtMs?: number | string | null; // Absolute timestamp
  createdAtMs?: number | string;
  repayMint?: string;
  collateralMint?: string;
  repayDecimals?: number;
  collateralDecimals?: number;
  liquidationEligible?: boolean;
}

/**
 * PR62: Validate plan has required fields and correct version
 * Fail-fast with clear error message if plan is outdated or incomplete
 * 
 * Note: repayMint and collateralMint are now optional since liquidation builder
 * derives them from the obligation. They're kept for legacy compatibility.
 */
function validatePlanVersion(plan: Plan): asserts plan is FlashloanPlan {
  const planVersion = plan.planVersion ?? 0;
  
  if (planVersion < 2) {
    throw new Error(
      `ERROR: Plan version ${planVersion} is outdated (expected >= 2). ` +
      `Please regenerate tx_queue.json with the latest scheduler. ` +
      `Run: npm run snapshot:candidates to create fresh plans.`
    );
  }
  
  // Validate required PR2 fields (repayMint/collateralMint are now optional in PR62)
  const missingFields: string[] = [];
  if (!plan.obligationPubkey) missingFields.push('obligationPubkey');
  // Note: repayMint and collateralMint no longer required - derived from obligation
  
  if (missingFields.length > 0) {
    throw new Error(
      `ERROR: Plan is missing required fields: ${missingFields.join(', ')}. ` +
      `Please regenerate tx_queue.json with the latest scheduler. ` +
      `Run: npm run snapshot:candidates to create fresh plans.`
    );
  }
}

function loadPlans(): Plan[] {
  const qPath = path.join(process.cwd(), 'data', 'tx_queue.json');
  const pPath = path.join(process.cwd(), 'data', 'plans.forecast.json');
  if (fs.existsSync(qPath)) return JSON.parse(fs.readFileSync(qPath, 'utf8')) as Plan[];
  if (fs.existsSync(pPath)) return JSON.parse(fs.readFileSync(pPath, 'utf8')) as Plan[];
  return [];
}

function shouldWarnUnderfundedDryRun(nowMs: number): boolean {
  if ((nowMs - lastUnderfundedWarnMs) < 60_000) return false;
  lastUnderfundedWarnMs = nowMs;
  return true;
}

/**
 * Build full transaction with liquidation pipeline using CANONICAL builder.
 * 
 * This is the UNIFIED entry point for all transaction building paths.
 * Uses buildKaminoRefreshAndLiquidateIxsCanonical for consistent instruction assembly.
 * 
 * Canonical order (with flashloan):
 * 1. computeBudget
 * 2. flashBorrow (optional)
 * 3. preRefreshReserve(repay)
 * 4. preRefreshReserve(collateral)
 * 5. refreshFarmsForObligationForReserve (optional)
 * 6. refreshObligation
 * 7. postRefreshReserve(repay)
 * 8. postRefreshReserve(collateral)
 * 9. liquidateObligationAndRedeemReserveCollateral
 * 10. swap instructions (optional, after liquidate)
 * 11. flashRepay (optional)
 * 
 * @param plan - Flashloan plan with obligation and liquidation details
 * @param signer - Keypair for signing transactions
 * @param market - Kamino market pubkey
 * @param programId - Kamino program ID
 * @param opts - Options for swap inclusion and sizing
 * @returns Setup and main instructions with labels
 */
async function buildFullTransaction(
  plan: FlashloanPlan,
  signer: Keypair,
  market: PublicKey,
  programId: PublicKey,
  opts: { includeSwap?: boolean; useRealSwapSizing?: boolean; dry?: boolean } = {}
): Promise<{ 
  setupIxs: TransactionInstruction[]; 
  setupLabels: string[]; 
  missingAtas: Array<{ mint: string; ataAddress: string; purpose: 'repay' | 'collateral' | 'withdrawLiq' }>;
  ixs: TransactionInstruction[];
  labels: string[];
  swapIxs: TransactionInstruction[];
  swapLookupTables: AddressLookupTableAccount[];
  atomicIxs: TransactionInstruction[];
  atomicLabels: string[];
  atomicLookupTables: AddressLookupTableAccount[];
  metadata: {
    repayMint: PublicKey;
    collateralMint: PublicKey;
    withdrawCollateralMint: PublicKey;
    hasFarmsRefresh: boolean;
  };
}> {
  const built = await buildPlanTransactions({
    connection: getConnection(),
    signer,
    market,
    programId,
    plan,
    includeSwap: opts.includeSwap ?? true,
    useRealSwapSizing: opts.useRealSwapSizing ?? true,
    dry: opts.dry ?? false,
  });

  return {
    setupIxs: built.setupIxs,
    setupLabels: built.setupLabels,
    missingAtas: built.missingAtas,
    ixs: built.mainIxs,
    labels: built.mainLabels,
    swapIxs: built.swapIxs,
    swapLookupTables: built.swapLookupTables,
    atomicIxs: built.atomicIxs,
    atomicLabels: built.atomicLabels,
    atomicLookupTables: built.atomicLookupTables,
    metadata: {
      repayMint: built.repayMint,
      collateralMint: built.collateralMint,
      withdrawCollateralMint: built.withdrawCollateralMint,
      hasFarmsRefresh: built.hasFarmsRefresh,
    },
  };
}

interface ExecutorOpts {
  dry?: boolean;
  broadcast?: boolean;
}

// ExecutorResult interface for consistent return type
export interface ExecutorResult {
  status: string;
  signature?: string;
  [key: string]: unknown;
}

// Tick mutex to prevent overlapping executor runs
let tickInProgress = false;

// Exported API for scheduler
export async function runDryExecutor(opts?: ExecutorOpts): Promise<ExecutorResult> {
  // Check if previous tick is still in progress
  if (tickInProgress) {
    console.warn('[Executor] Tick skipped: previous tick still in progress');
    return { status: 'skipped-busy' };
  }
  
  // Set mutex flag
  tickInProgress = true;
  
  try {
    // Load env early to ensure .env variables exist under WSL
    const env = loadEnv();
    const dry = opts?.dry ?? true;
    const broadcast = opts?.broadcast ?? false;

    // Log tick start with mode flags
    console.log(`[Executor] Tick start (dry=${dry}, broadcast=${broadcast})`);

    const connection = getConnection();

    const minEv = Number(env.EXEC_MIN_EV ?? env.SCHED_MIN_EV ?? 0);
    const maxTtlMin = Number(env.EXEC_MAX_TTL_MIN ?? env.SCHED_MAX_TTL_MIN ?? 999999);
    const minFeePayerLamports = Math.floor(Number(env.EXEC_MIN_FEE_PAYER_SOL ?? 0.05) * LAMPORTS_PER_SOL);
    const minDelayMs = Number(env.SCHEDULED_MIN_LIQUIDATION_DELAY_MS ?? 0);
    const ttlGraceMs = Number(env.TTL_GRACE_MS ?? 60_000);
    const ttlUnknownPasses = (env.TTL_UNKNOWN_PASSES ?? 'true') === 'true';
    const forceIncludeLiquidatable = (env.SCHED_FORCE_INCLUDE_LIQUIDATABLE ?? 'true') === 'true';
    const dryRunSetupCacheTtlMs = Math.max(0, Number(env.EXEC_DRY_RUN_SETUP_CACHE_TTL_SECONDS ?? 300) * 1000);
    const presubmitEnabled = (env.PRESUBMIT_ENABLED ?? 'false') === 'true';
    const presubmitTopK = Number(env.PRESUBMIT_TOPK ?? 5);
    const presubmitRefreshMs = Number(process.env.PRESUBMIT_REFRESH_MS ?? 3000);

    console.log('[Executor] Filter thresholds:');
    console.log(`  EXEC_MIN_EV: ${minEv}`);
    console.log(`  EXEC_MAX_TTL_MIN: ${maxTtlMin}`);
    console.log(`  EXEC_MIN_FEE_PAYER_SOL: ${Number(env.EXEC_MIN_FEE_PAYER_SOL ?? 0.05)}`);
    console.log(`  TTL_GRACE_MS: ${ttlGraceMs}`);
    console.log(`  TTL_UNKNOWN_PASSES: ${ttlUnknownPasses}`);
    console.log(`  SCHED_FORCE_INCLUDE_LIQUIDATABLE: ${forceIncludeLiquidatable}`);

    const plans = loadPlans();
    if (!Array.isArray(plans) || plans.length === 0) {
      console.log('No plans available. Ensure data/tx_queue.json exists (PR10/PR11).');
      return { status: 'no-plans' };
    }

    if (!startupFeePayerCheckDone) {
      startupFeePayerCheckDone = true;
      try {
        const kpPath = normalizeWslPath(env.BOT_KEYPAIR_PATH);
        const secret = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
        const startupSigner = Keypair.fromSecretKey(Uint8Array.from(secret));
        const startupBalanceLamports = await connection.getBalance(startupSigner.publicKey);
        if (startupBalanceLamports < minFeePayerLamports) {
          console.warn(
            `[Executor] Fee payer low balance: ${(startupBalanceLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL < ${(minFeePayerLamports / LAMPORTS_PER_SOL).toFixed(2)} SOL (EXEC_MIN_FEE_PAYER_SOL)`
          );
        }
      } catch (err) {
        console.warn(`[Executor] Startup fee payer balance check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Filter with reason tracking
    const nowMs = Date.now();
    const filterReasons = {
      total: plans.length,
    rejected_ev: 0,
    rejected_ttl_expired: 0,
    rejected_ttl_too_high: 0,
    rejected_hazard: 0,
    accepted_liquidatable_forced: 0,
    accepted_normal: 0,
  };

  const candidates = plans
    .filter(p => {
      // Force-include liquidatable if enabled
      if (forceIncludeLiquidatable && p.liquidationEligible) {
        filterReasons.accepted_liquidatable_forced++;
        return true;
      }
      
      // EV filter
      if (Number(p.ev ?? 0) <= minEv) {
        filterReasons.rejected_ev++;
        return false;
      }
      
      // TTL filter with new logic
      const ttlMin = p.ttlMin;
      const predictedAtMs = typeof p.predictedLiquidationAtMs === 'number' ? p.predictedLiquidationAtMs : (
        typeof p.predictedLiquidationAtMs === 'string' ? Number(p.predictedLiquidationAtMs) : null
      );
      
      // Handle null/unknown TTL
      if (ttlMin === null || ttlMin === undefined) {
        if (!ttlUnknownPasses) {
          filterReasons.rejected_ttl_expired++;
          return false;
        }
        // Unknown TTL passes if allowed
      } else {
        const ttlMinNum = Number(ttlMin);
        
        // Check if negative (already expired)
        if (ttlMinNum < 0) {
          filterReasons.rejected_ttl_expired++;
          return false;
        }
        
        // Check if past predicted time + grace
        if (predictedAtMs !== null && nowMs > predictedAtMs + ttlGraceMs) {
          filterReasons.rejected_ttl_expired++;
          return false;
        }
        
        // Check if TTL too high
        if (ttlMinNum > maxTtlMin) {
          filterReasons.rejected_ttl_too_high++;
          return false;
        }
      }
      
      filterReasons.accepted_normal++;
      return true;
    })
    .sort((a, b) => {
      // Primary: liquidationEligible (true first)
      const liqDiff = (b.liquidationEligible ? 1 : 0) - (a.liquidationEligible ? 1 : 0);
      if (liqDiff !== 0) return liqDiff;
      
      // Secondary: EV desc
      const evDiff = Number(b.ev ?? 0) - Number(a.ev ?? 0);
      if (evDiff !== 0) return evDiff;
      
      // Tertiary: TTL asc (treat null as Infinity)
      const aTtl = a.ttlMin !== null && a.ttlMin !== undefined ? Number(a.ttlMin) : Infinity;
      const bTtl = b.ttlMin !== null && b.ttlMin !== undefined ? Number(b.ttlMin) : Infinity;
      const ttlDiff = aTtl - bTtl;
      if (ttlDiff !== 0) return ttlDiff;
      
      // Quaternary: hazard desc
      return Number(b.hazard ?? 0) - Number(a.hazard ?? 0);
    });

  console.log('[Executor] Filter results:', filterReasons);

  if (candidates.length === 0) {
    console.log('[Executor] No eligible candidates based on EV/TTL thresholds.');
    return { status: 'no-eligible' };
  }

  if (presubmitEnabled) {
    if (!presubmitterSingleton) {
      const kpPath = normalizeWslPath(env.BOT_KEYPAIR_PATH);
      const secret = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
      const signer = Keypair.fromSecretKey(Uint8Array.from(secret));
      const market = new PublicKey(env.KAMINO_MARKET_PUBKEY || '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
      const programId = new PublicKey(env.KAMINO_KLEND_PROGRAM_ID || 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
      presubmitterSingleton = new Presubmitter({
        connection,
        signer,
        market,
        programId,
        topK: presubmitTopK,
        refreshMs: presubmitRefreshMs,
      });
    }
    try {
      await presubmitterSingleton.prebuildTopK(candidates as FlashloanPlan[]);
    } catch (err) {
      console.warn('[Executor] Presubmit prebuild failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // Multi-attempt executor: try multiple candidates per tick
  const maxAttempts = Number(process.env.BOT_MAX_ATTEMPTS_PER_CYCLE ?? 10);
  console.log(`[Executor] Selected ${candidates.length} eligible plans, attempting up to ${maxAttempts}`);
  let lastDryRunSetupCacheSkip: { planKey: string; blockedUntilMs: number } | undefined;

  for (let attemptIdx = 0; attemptIdx < Math.min(maxAttempts, candidates.length); attemptIdx++) {
    const target = candidates[attemptIdx];
    const planKey = String(target.key);
    console.log(`\n[Executor] ═══ Attempt ${attemptIdx + 1}/${Math.min(maxAttempts, candidates.length)}: ${String(target.key).slice(0, 8)}... ═══`);
    
    // PR2: Validate plan version and required fields
    try {
      validatePlanVersion(target);
    } catch (err) {
      console.error('[Executor] Invalid plan version:', err instanceof Error ? err.message : String(err));
      continue; // Skip to next candidate
    }
    
    // Guard: Skip incomplete/legacy plans (missing reserve pubkeys or empty collateralMint)
    if (!isPlanComplete(target)) {
      console.error('[Executor] ❌ legacy_or_incomplete_plan: Cannot execute liquidation with incomplete plan');
      console.error('[Executor]    This plan is missing critical fields needed for liquidation:');
      
      const missing = getMissingFields(target);
      if (missing.repayReservePubkey === 'missing') {
        console.error('[Executor]      - repayReservePubkey: missing');
      }
      if (missing.collateralReservePubkey === 'missing') {
        console.error('[Executor]      - collateralReservePubkey: missing');
      }
      if (missing.collateralMint === 'missing') {
        console.error('[Executor]      - collateralMint: missing or empty');
      }
      
      console.error('[Executor]    Skipping this plan to prevent Custom(6006) InvalidAccountInput errors.');
      console.error('[Executor]    Dropping stale plan from queue.');
      await dropPlanFromQueue(String(target.key));
      continue; // Skip to next candidate
    }

    if (isBlocked(planKey)) {
      console.log(`[Executor] Skipping blocked plan ${String(target.key).slice(0, 8)} (insufficient-rent cooldown)`);
      continue;
    }

    const healthyCooldownUntil = obligationHealthyCooldown.get(planKey) ?? 0;
    if (healthyCooldownUntil > Date.now()) {
      console.log(`[Executor] Skipping ${planKey.slice(0, 8)} due to obligation-healthy cooldown (${Math.ceil((healthyCooldownUntil - Date.now()) / 1000)}s remaining)`);
      continue;
    }

    if (dry && dryRunSetupCacheTtlMs > 0) {
      const blockedUntilMs = dryRunSetupRequiredCache.get(planKey);
      if (blockedUntilMs && nowMs < blockedUntilMs) {
        console.log(`[Executor] Skipping ${planKey.slice(0, 8)} due to dry-run setup cache (${Math.ceil((blockedUntilMs - nowMs) / 1000)}s remaining)`);
        lastDryRunSetupCacheSkip = { planKey, blockedUntilMs };
        continue;
      }
    }
    
    const now = Date.now();
    const createdAtMs = Number(target.createdAtMs ?? 0);
    const ageMs = createdAtMs ? (now - createdAtMs) : Infinity;
    if (minDelayMs > 0 && ageMs < minDelayMs) {
      console.log(`[Executor] Skipping due to SCHEDULED_MIN_LIQUIDATION_DELAY_MS (${minDelayMs}ms). Age: ${ageMs}ms`);
      continue; // Skip to next candidate
    }

    // Execute this candidate (wrapped in try-catch for error handling)
    try {
      const kpPath = normalizeWslPath(env.BOT_KEYPAIR_PATH);
      if (!kpPath || !fs.existsSync(kpPath)) {
        console.error(`[Executor] Keypair not found at ${kpPath}.`);
        continue; // Skip to next candidate
      }
      const secret = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
      const signer = Keypair.fromSecretKey(Uint8Array.from(secret));

      const market = new PublicKey(env.KAMINO_MARKET_PUBKEY || '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
      const programId = new PublicKey(env.KAMINO_KLEND_PROGRAM_ID || 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

      console.log('[Executor] Building full transaction...');
  const buildStart = Date.now();
  
  // Final PR: Use real swap sizing when not in mock/test mode
  const useRealSwapSizing = !dry; // Use real sizing for broadcast mode, skip for dry-run
  
  // PR2: Build full transaction pipeline (now returns setupIxs + ixs + labels + metadata)
  // Wrap in try/catch to handle swap sizing failures gracefully without crashing the bot
  let setupIxs: TransactionInstruction[];
  let setupLabels: string[];
  let missingAtas: Array<{ mint: string; ataAddress: string; purpose: 'repay' | 'collateral' | 'withdrawLiq' }>;
  let ixs: TransactionInstruction[];
  let labels: string[];
  let swapIxs: TransactionInstruction[];
  let swapLookupTables: AddressLookupTableAccount[];
  let atomicIxs: TransactionInstruction[];
  let atomicLabels: string[];
  let atomicLookupTables: AddressLookupTableAccount[];
  let metadata: { hasFarmsRefresh: boolean; repayMint: PublicKey; collateralMint: PublicKey; withdrawCollateralMint: PublicKey };
  let presubmittedTx: VersionedTransaction | undefined;
  
  try {
    if (presubmitEnabled && presubmitterSingleton && target.obligationPubkey) {
      const entry = await presubmitterSingleton.getOrBuild(target as FlashloanPlan);
      if (entry.tx && !entry.needsSetupFirst && entry.mode === 'atomic') {
        console.log(`[Executor] using presubmitted tx for ${target.obligationPubkey}`);
        presubmittedTx = entry.tx;
      }
    }

    const result = await buildFullTransaction(target, signer, market, programId, {
      includeSwap: true,
      useRealSwapSizing,
      dry,
    });
    setupIxs = result.setupIxs;
    setupLabels = result.setupLabels;
    missingAtas = result.missingAtas;
    ixs = result.ixs;
    labels = result.labels;
    swapIxs = result.swapIxs;
    swapLookupTables = result.swapLookupTables;
    atomicIxs = result.atomicIxs;
    atomicLabels = result.atomicLabels;
    atomicLookupTables = result.atomicLookupTables;
    metadata = result.metadata;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    
    // Check if it's OBLIGATION_HEALTHY error from buildFullTransaction
    if (errMsg === 'OBLIGATION_HEALTHY') {
      console.error('[Executor] ℹ️  6016 ObligationHealthy - plan skipped');
      obligationHealthyCooldown.set(planKey, Date.now() + (5 * 60 * 1000));
      return { status: 'obligation-healthy' };
    }
    
    console.error('[Executor] ❌ Failed to build transaction:', errMsg);
    console.error('[Executor] This plan will be skipped. Bot will continue with next cycle.');
    return { status: 'build-failed' };
  }
  
  const buildMs = Date.now() - buildStart;
  console.log(`[Executor] Built ${ixs.length} liquidation instructions in ${buildMs}ms`);
  
  // TX Size Fix: Handle setup transaction if needed
  if (setupIxs.length > 0) {
    console.log(`\n[Executor] ⚠️  Setup required: ${setupIxs.length} ATA(s) need to be created`);
    console.log(`[Executor] Building atomic setup+liquidation path`);
    
    // Assertion: Verify setup labels match setup instructions
    // This should never fail unless there's a bug in the label generation logic
    if (setupLabels.length !== setupIxs.length) {
      const errorMsg = 
        `Setup instruction/label count mismatch: ${setupIxs.length} instructions but ${setupLabels.length} labels. ` +
        `This indicates a bug in the liquidation builder's setupAtaNames array generation.`;
      console.error(`[Executor] ❌ Setup label/instruction count mismatch!`);
      throw new Error(errorMsg);
    }
    
    // Print setup instruction map
    console.log('\n[Executor] ═══ SETUP INSTRUCTION MAP ═══');
    setupLabels.forEach((label, idx) => {
      console.log(`  [${idx}] ${label}`);
    });
    console.log('═══════════════════════════════════\n');

    if (cachedAtaRentLamports === undefined) {
      cachedAtaRentLamports = await connection.getMinimumBalanceForRentExemption(ATA_ACCOUNT_SIZE);
    }
    const rentPerAtaLamports = cachedAtaRentLamports;
    const rentLamports = rentPerAtaLamports * missingAtas.length;
    const requiredLamports = Math.max(rentLamports + SETUP_FEE_BUFFER_LAMPORTS, minFeePayerLamports);
    const feePayerLamports = await connection.getBalance(signer.publicKey);
    const balanceTooLow = feePayerLamports < requiredLamports;
    if (balanceTooLow) {
      markBlocked(planKey, 'insufficient-rent');
      await downgradeBlockedPlan(planKey);
      if (dry && shouldWarnUnderfundedDryRun(Date.now())) {
        console.warn(
          `[Executor] setup-blocked insufficient-rent: fee payer ${(feePayerLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL, required ${(requiredLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL, min ${(minFeePayerLamports / LAMPORTS_PER_SOL).toFixed(2)} SOL`
        );
      } else {
        console.log(
          `[Executor] Setup blocked (insufficient-rent): ${(feePayerLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL < ${(requiredLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`
        );
      }
      return { status: 'blocked-insufficient-rent', planKey, requiredLamports, feePayerLamports };
    }
    
    const atomicBh = await connection.getLatestBlockhash();
    const atomicTx = await buildVersionedTx({
      payer: signer.publicKey,
      blockhash: atomicBh.blockhash,
      instructions: atomicIxs,
      lookupTables: atomicLookupTables,
      signer,
    });

    console.log('[Executor] Simulating atomic setup+liquidation transaction...');
    const atomicSim = await connection.simulateTransaction(atomicTx);
    if (atomicSim.value.err) {
      const customCode = extractCustomCode(atomicSim.value.err);
      if (customCode === 6016) {
        obligationHealthyCooldown.set(planKey, Date.now() + (5 * 60 * 1000));
        return { status: 'obligation-healthy' };
      }

      const swapWasSkippedForSetup = swapIxs.length === 0 && !metadata.collateralMint.equals(metadata.repayMint);
      if (
        broadcast &&
        swapWasSkippedForSetup &&
        shouldFallbackToSetupOnly(atomicSim.value.err, atomicSim.value.logs ?? undefined)
      ) {
        console.log('[Executor] Atomic preflight indicates setup-first required for swap sizing, falling back to setup-only broadcast.');
        const setupBh = await connection.getLatestBlockhash();
        const setupMsg = new TransactionMessage({
          payerKey: signer.publicKey,
          recentBlockhash: setupBh.blockhash,
          instructions: setupIxs,
        });
        const setupTx = await buildVersionedTx({
          payer: signer.publicKey,
          blockhash: setupBh.blockhash,
          instructions: setupIxs,
          signer,
        });
        const setupAttempts = await sendWithBoundedRetry(
          connection,
          setupTx,
          signer,
          setupMsg,
          {
            maxAttempts: 2,
            cuLimit: 200_000,
            cuPrice: Number(process.env.EXEC_CU_PRICE ?? 0),
            cuLimitBumpFactor: 1.5,
            cuPriceBumpMicrolamports: 50000,
          }
        );
        console.log(formatAttemptResults(setupAttempts));
        const finalSetupAttempt = setupAttempts[setupAttempts.length - 1];
        if (finalSetupAttempt?.success) {
          for (const ata of missingAtas) markAtaCreated(ata.mint);
          return { status: 'setup-completed', signature: finalSetupAttempt.signature };
        }
        return { status: 'setup-failed' };
      }

      if (dry && dryRunSetupCacheTtlMs > 0) {
        dryRunSetupRequiredCache.set(planKey, Date.now() + dryRunSetupCacheTtlMs);
      }
      return { status: dry ? 'dry-atomic-sim-failed' : 'atomic-preflight-failed' };
    }

    if (dry || !broadcast) {
      if (dry && dryRunSetupCacheTtlMs > 0) {
        dryRunSetupRequiredCache.delete(planKey);
      }
      return { status: 'dry-atomic-sim-ok' };
    }

    const atomicMaxAttempts = Number(process.env.BOT_MAX_ATTEMPTS_PER_PLAN ?? 2);
    const atomicCuLimit = Number(process.env.EXEC_CU_LIMIT ?? 600_000);
    const atomicCuPrice = Number(process.env.EXEC_CU_PRICE ?? 0);
    const atomicAttempts = await sendWithRebuildRetry(
      connection,
      signer,
      async ({ blockhash, cuLimit, cuPrice }) => {
        const rebuilt = withUpdatedComputeBudget(atomicIxs, atomicLabels, cuLimit, cuPrice);
        return buildVersionedTx({
          payer: signer.publicKey,
          blockhash,
          instructions: rebuilt.instructions,
          lookupTables: atomicLookupTables,
          signer,
        });
      },
      {
        maxAttempts: atomicMaxAttempts,
        cuLimit: atomicCuLimit,
        cuPrice: atomicCuPrice,
        cuLimitBumpFactor: 1.5,
        cuPriceBumpMicrolamports: 50000,
      }
    );
    console.log(formatAttemptResults(atomicAttempts));
    const finalAtomicAttempt = atomicAttempts[atomicAttempts.length - 1];
    if (finalAtomicAttempt?.success) {
      for (const ata of missingAtas) markAtaCreated(ata.mint);
      return { status: 'atomic-sent', signature: finalAtomicAttempt.signature };
    }
    return { status: 'atomic-preflight-failed' };
  }
  
  // Assertion: Verify labels match instructions
  if (labels.length !== ixs.length) {
    const errorMsg = 
      `Internal error: Instruction label count (${labels.length}) does not match instruction count (${ixs.length}). ` +
      `This indicates a bug in instruction building or labeling logic. ` +
      `Instructions: ${ixs.length}, Labels: ${labels.length}`;
    console.error(`[Executor] ❌ CRITICAL: Label/Instruction count mismatch!`);
    console.error(`[Executor]    Instructions: ${ixs.length}`);
    console.error(`[Executor]    Labels: ${labels.length}`);
    throw new Error(errorMsg);
  }
  
  // Print instruction map for debugging (only in dry-run mode to avoid cluttering production logs)
  if (dry) {
    console.log('\n[Executor] ═══ INSTRUCTION MAP ═══');
    labels.forEach((label, idx) => {
      console.log(`  [${idx}] ${label}`);
    });
    console.log('═══════════════════════════════\n');
  }

  // Build and sign transaction
  const bh = await connection.getLatestBlockhash();
  const tx = presubmittedTx ?? await buildVersionedTx({
    payer: signer.publicKey,
    blockhash: bh.blockhash,
    instructions: ixs,
    lookupTables: swapLookupTables,
    signer,
  });

  // COMPILED INSTRUCTION WINDOW VALIDATION
  // Validate the compiled transaction against expected canonical sequence
  // This catches any divergence between label-based validation and actual compiled message
  console.log('\n[Executor] Validating compiled instruction window...');
  const validationHasFarms = presubmittedTx
    ? decodeCompiledInstructionKinds(tx).some((kind) => kind.kind === 'refreshObligationFarmsForReserve')
    : metadata.hasFarmsRefresh;
  const validation = validateCompiledInstructionWindow(tx, validationHasFarms);
  
  if (!validation.valid) {
    console.error('[Executor] ⚠️  COMPILED VALIDATION MISMATCH:');
    console.error(validation.diagnostics);
    console.error('\n[Executor] Transaction build-time validation warning to prevent 6051/6009');
    console.error('[Executor] This indicates instruction assembly divergence.');
    console.error('[Executor] Skipping this plan and continuing with next cycle.\n');
    return { status: 'compiled-validation-failed' };
  }
  
  console.log(validation.diagnostics);
  
  // Also decode and log the full compiled instruction kinds for diagnostics
  const compiledKinds = decodeCompiledInstructionKinds(tx);
  console.log('\n[Executor] ═══ COMPILED INSTRUCTION KINDS ═══');
  compiledKinds.forEach((kind, idx) => {
    const labelMatch = labels[idx] ? ` (label: ${labels[idx]})` : '';
    console.log(`  [${idx}] ${kind.kind}${labelMatch}`);
  });
  console.log('═══════════════════════════════════════\n');

  if (dry || !broadcast) {
    // Simulate transaction
    const simStart = Date.now();
    const sim = await connection.simulateTransaction(tx);
    const simMs = Date.now() - simStart;
    
    console.log(`[Executor] Simulation completed in ${simMs}ms`);
    if (sim.value.err) {
      // PART D: Enhanced error logging with instruction labels and sim logs
      const err = sim.value.err;
      console.error('[Executor] Simulation error:', err);
      
      // Print simulation logs for debugging (CRITICAL for troubleshooting)
      if (sim.value.logs && sim.value.logs.length > 0) {
        console.error('\n[Executor] ═══ SIMULATION LOGS ═══');
        sim.value.logs.forEach((log, i) => {
          console.error(`  [${i}] ${log}`);
        });
        console.error('═══════════════════════════════\n');
      }
      
      // Check if it's an InstructionError with Custom error
      if (typeof err === 'object' && err !== null && 'InstructionError' in err) {
        const instructionError = (err as any).InstructionError;
        const ixIndex = instructionError[0];
        const innerError = instructionError[1];
        
        // Map instruction index to label for better debugging
        const ixLabel = labels[ixIndex] || `unknown(${ixIndex})`;
        
        // Check for Custom error
        if (typeof innerError === 'object' && innerError !== null && 'Custom' in innerError) {
          const customCode = innerError.Custom;
          
          // Log structured block for Custom errors
          console.error('\n[Executor] ═══ CUSTOM ERROR DIAGNOSTIC ═══');
          console.error(`  Error Code: Custom(${customCode})`);
          console.error(`  Instruction Index: ${ixIndex}`);
          console.error(`  Instruction Label: ${ixLabel}`);
          console.error(`  Obligation: ${target.obligationPubkey}`);
          if (target.repayReservePubkey) {
            console.error(`  Repay Reserve (from plan): ${target.repayReservePubkey}`);
          }
          if (target.collateralReservePubkey) {
            console.error(`  Collateral Reserve (from plan): ${target.collateralReservePubkey}`);
          }
          
          // Print instruction index map for context
          console.error('\n  Instruction Map:');
          labels.forEach((label, idx) => {
            const marker = idx === ixIndex ? ' ← FAILED HERE' : '';
            console.error(`    [${idx}] ${label}${marker}`);
          });
          
          // Decode known Kamino error codes
          const knownErrors: Record<number, string> = {
            6006: 'InvalidAccountInput - Remaining accounts order or reserve mismatch',
            6015: 'LiquidationTooSmall - Liquidation amount below minimum',
            6016: 'ObligationHealthy - Cannot liquidate healthy obligation',
            6017: 'ObligationStale - Obligation needs refresh',
            6018: 'ObligationReserveLimit - Reserve limit reached',
            6032: 'NoFlashRepayFound - No corresponding repay found for flash borrow',
          };
          
          if (knownErrors[customCode]) {
            console.error(`\n  Decoded: ${knownErrors[customCode]}`);
          }
          
          // If it's 6016 ObligationHealthy, treat as soft failure (skip and continue)
          if (customCode === 6016) {
            obligationHealthyCooldown.set(planKey, Date.now() + (5 * 60 * 1000));
            console.error('\n  ℹ️  SOFT FAILURE (6016 ObligationHealthy):');
            console.error('     The obligation is currently healthy and cannot be liquidated.');
            console.error('     This is a legitimate runtime state - the obligation may have been');
            console.error('     repaid, price moved favorably, or another bot liquidated it first.');
            console.error('\n  ✅ ACTION: Skipping this plan and continuing with next cycle.\n');
            console.error('═══════════════════════════════════════\n');
            return { status: 'obligation-healthy' };
          }
          
          // If it's 6006, provide specific guidance
          if (customCode === 6006) {
            // Extra diagnostics for 6006: dump exact compiled accounts for the failed ix.
            // Especially useful if label says refreshObligation.
            dumpCompiledIxAccounts({ tx, ixIndex, label: ixLabel });
            console.error(`[Executor][DEBUG_REFRESH_OBLIGATION] failedIxLabel=${ixLabel}`);
            console.error(`[Executor][DEBUG_REFRESH_OBLIGATION] obligation=${target.obligationPubkey}`);
            console.error('\n  💡 LIKELY CAUSE:');
            console.error('     The reserves selected for liquidation do not match the obligation\'s');
            console.error('     actual borrows/deposits. This happens when:');
            console.error('     - Plan was created with generic USDC/SOL but obligation has different assets');
            console.error('     - Obligation changed since plan was created');
            console.error('     - Reserve pubkeys in plan are missing or incorrect');
            console.error('     - refreshObligation missing required remaining accounts (ALL reserves)');
            console.error('\n  ✅ SOLUTION:');
            console.error('     Regenerate tx_queue.json with: npm run snapshot:candidates');
            console.error('     This will extract correct reserve pubkeys from each obligation.');
          }
          
          // If it's 6032, provide specific guidance for flash loan mismatch
          if (customCode === 6032) {
            console.error('\n  💡 LIKELY CAUSE:');
            console.error('     Flash loan borrow and repay instructions are mismatched.');
            console.error('     This can happen when:');
            console.error('     - FlashRepay instruction is missing or in wrong position');
            console.error('     - Simulation uses incomplete instruction sequence');
            console.error('     - Flash borrow amount doesn\'t match expected repay amount');
            console.error('\n  ✅ SOLUTION:');
            console.error('     Ensure transaction includes both FlashBorrow and FlashRepay instructions.');
            console.error('     For seized-delta simulation, use the full liquidation sequence.');
          }
          
          console.error('═══════════════════════════════════════\n');
        } else {
          // Non-Custom error: still print instruction label
          console.error(`\n[Executor] Instruction ${ixIndex} (${ixLabel}) failed with error:`, innerError);
          console.error('\n  Instruction Map:');
          labels.forEach((label, idx) => {
            const marker = idx === ixIndex ? ' ← FAILED HERE' : '';
            console.error(`    [${idx}] ${label}${marker}`);
          });
          console.error('');
        }
      }
      
      return { status: 'sim-error' };
    }
    
    console.log('[Executor] Simulation success:');
    console.log(`  CU used: ${sim.value.unitsConsumed ?? 'unknown'}`);
    console.log(`  Logs: ${sim.value.logs?.length ?? 0} entries`);
    
    return { status: 'simulated' };
  } else {
    // Broadcast transaction with bounded retries
    console.log('[Executor] Broadcasting transaction with bounded retries...');
    
    // Get retry config from env (reuse CU settings from buildFullTransaction)
    const maxAttempts = Number(process.env.BOT_MAX_ATTEMPTS_PER_PLAN ?? 2);
    const cuLimit = Number(process.env.EXEC_CU_LIMIT ?? 600_000);
    const cuPrice = Number(process.env.EXEC_CU_PRICE ?? 0);
    
    console.log(`[Executor] Retry config: maxAttempts=${maxAttempts}, cuLimit=${cuLimit}, cuPrice=${cuPrice}`);
    
    try {
      const attempts = await sendWithRebuildRetry(
        connection,
        signer,
        async ({ blockhash, cuLimit, cuPrice }) => {
          const rebuilt = withUpdatedComputeBudget(ixs, labels, cuLimit, cuPrice);
          return buildVersionedTx({
            payer: signer.publicKey,
            blockhash,
            instructions: rebuilt.instructions,
            lookupTables: swapLookupTables,
            signer,
          });
        },
        {
          maxAttempts,
          cuLimit,
          cuPrice,
          cuLimitBumpFactor: 1.5,
          cuPriceBumpMicrolamports: 50000,
        }
      );
      
      // Log all attempts
      console.log(formatAttemptResults(attempts));
      
      // Get final result
      const finalAttempt = attempts[attempts.length - 1];
      
      if (finalAttempt && finalAttempt.success) {
        console.log('[Executor] Transaction confirmed successfully!');
        return { 
          status: 'confirmed', 
          signature: finalAttempt.signature
        };
      } else {
        console.error('[Executor] All broadcast attempts failed for this plan');
        // Continue to next candidate instead of returning
        continue;
      }
      
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[Executor] Broadcast error:', errMsg);
      
      // Check for stale plan indicators
      if (/missing obligation|invalid account|decode failed|account not found/i.test(errMsg)) {
        console.warn(`[Executor] Stale plan detected in broadcast: ${errMsg}`);
        console.warn(`[Executor] Dropping plan ${String(target.key).slice(0, 8)} from queue`);
        await dropPlanFromQueue(String(target.key));
      }
      
      // Continue to next candidate
      continue;
    }
  } // end else (broadcast mode)
  } catch (outerErr) {
    // Catch any unexpected errors in the attempt loop
    const errMsg = outerErr instanceof Error ? outerErr.message : String(outerErr);
    console.error('[Executor] Unexpected error during attempt:', errMsg);
    
    // Check for stale plan indicators
    if (/missing obligation|invalid account|decode failed|account not found/i.test(errMsg)) {
      console.warn(`[Executor] Stale plan detected: ${errMsg}`);
      console.warn(`[Executor] Dropping plan ${String(target.key).slice(0, 8)} from queue`);
      await dropPlanFromQueue(String(target.key));
    }
    
    // Continue to next candidate
    continue;
  }
  } // end for loop (multi-attempt)
  
  if (lastDryRunSetupCacheSkip) {
    return { status: 'skipped-dry-run-setup-cache', ...lastDryRunSetupCacheSkip };
  }

  // All attempts completed without success
  console.log('[Executor] All attempts completed');
  return { status: 'all-attempts-completed' };
  } finally {
    // Always release the tick mutex
    tickInProgress = false;
  }
}

// Preserve CLI behavior (standalone run)
(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--dryrun') || args.includes('--dry')) {
    await runDryExecutor({ dry: true, broadcast: false });
  } else if (args.includes('--broadcast')) {
    await runDryExecutor({ dry: false, broadcast: true });
  }
})();
