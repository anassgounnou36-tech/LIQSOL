import fs from 'node:fs';
import path from 'node:path';
import { Keypair, VersionedTransaction, TransactionMessage, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getConnection } from '../solana/connection.js';
import { buildJupiterSwapIxs } from './swapBuilder.js';
import { loadEnv } from '../config/env.js';
import { normalizeWslPath } from '../utils/path.js';
import { resolveMintFlexible } from '../solana/mint.js';
import { sendWithBoundedRetry, formatAttemptResults } from './broadcastRetry.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';
import { isPlanComplete, getMissingFields } from '../scheduler/planValidation.js';
import { buildKaminoRefreshAndLiquidateIxsCanonical, validateCompiledInstructionWindow, decodeCompiledInstructionKinds } from '../kamino/canonicalLiquidationIxs.js';
import { dropPlanFromQueue } from '../scheduler/txScheduler.js';

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
  opts: { includeSwap?: boolean; useRealSwapSizing?: boolean } = {}
): Promise<{ 
  setupIxs: TransactionInstruction[]; 
  setupLabels: string[]; 
  ixs: TransactionInstruction[]; 
  labels: string[];
  metadata: {
    repayMint: PublicKey;
    collateralMint: PublicKey;
    withdrawCollateralMint: PublicKey;
    hasFarmsRefresh: boolean;
  };
}> {
  const connection = getConnection();
  
  // Get env for config
  const cuLimit = Number(process.env.EXEC_CU_LIMIT ?? 600_000);
  const cuPrice = Number(process.env.EXEC_CU_PRICE ?? 0);
  
  // Parse expected reserve pubkeys from plan
  let repayMintPreference: PublicKey | undefined;
  let expectedRepayReservePubkey: PublicKey | undefined;
  let expectedCollateralReservePubkey: PublicKey | undefined;
  
  if (plan.repayMint) {
    try {
      repayMintPreference = resolveMintFlexible(plan.repayMint);
    } catch (err) {
      console.error(
        `[Executor] Failed to resolve repayMint for plan ${plan.key}:`,
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }
  }
  
  if (plan.repayReservePubkey) {
    try {
      expectedRepayReservePubkey = new PublicKey(plan.repayReservePubkey);
      console.log(`[Executor] Using expected repay reserve: ${expectedRepayReservePubkey.toBase58()}`);
    } catch (err) {
      console.warn(
        `[Executor] Invalid repayReservePubkey in plan: ${plan.repayReservePubkey}`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  
  if (plan.collateralReservePubkey) {
    try {
      expectedCollateralReservePubkey = new PublicKey(plan.collateralReservePubkey);
      console.log(`[Executor] Using expected collateral reserve: ${expectedCollateralReservePubkey.toBase58()}`);
    } catch (err) {
      console.warn(
        `[Executor] Invalid collateralReservePubkey in plan: ${plan.collateralReservePubkey}`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  
  // Step 1: Build canonical liquidation sequence WITHOUT swap (to size seized collateral)
  const mint = (plan.mint || 'USDC') as string;
  const amountUi = String(plan.amountUi ?? plan.amountUsd ?? '100');
  
  const canonicalConfig = {
    connection,
    signer,
    marketPubkey: market,
    programId,
    obligationPubkey: new PublicKey(plan.obligationPubkey),
    cuLimit,
    cuPrice,
    flashloan: {
      mint,
      amountUi,
    },
    repayMintPreference,
    repayAmountUi: plan.amountUi,
    expectedRepayReservePubkey,
    expectedCollateralReservePubkey,
  };
  
  // Build initial canonical instructions (without swap)
  const initialCanonical = await buildKaminoRefreshAndLiquidateIxsCanonical(canonicalConfig);
  
  // Extract setup instructions and metadata
  const setupIxs = initialCanonical.setupIxs;
  const { repayMint, collateralMint, withdrawCollateralMint, hasFarmsRefresh } = initialCanonical;
  
  // Step 2: Handle swap sizing if needed
  let swapInstructions: TransactionInstruction[] = [];
  
  if (opts.includeSwap && !collateralMint.equals(repayMint)) {
    console.log('[Executor] Swap required: collateral mint differs from repay mint');
    console.log(`[Executor]   Collateral (liquidity): ${collateralMint.toBase58()}`);
    console.log(`[Executor]   Collateral (redemption): ${withdrawCollateralMint.toBase58()}`);
    console.log(`[Executor]   Repay: ${repayMint.toBase58()}`);
    
    // Gate swap sizing behind ATA setup
    if (setupIxs.length > 0) {
      console.log('[Executor] ⚠️  Swap sizing skipped: Setup required (ATAs missing)');
      console.log('[Executor] Setup transaction must be sent first. Swap sizing will run in next cycle.');
    } else if (opts.useRealSwapSizing) {
      console.log('[Executor] Using REAL swap sizing via deterministic seized-delta estimation...');
      
      try {
        // Import seized delta estimator
        const { estimateSeizedCollateralDeltaBaseUnits } = await import('./seizedDeltaEstimator.js');
        const { formatBaseUnitsToUiString } = await import('./swapBuilder.js');
        
        // Build simulation transaction using canonical builder (WITHOUT flashloan, WITHOUT swap)
        // This avoids error 6032 (NoFlashRepayFound) during simulation
        const simConfig = {
          ...canonicalConfig,
          flashloan: undefined, // No flashloan in simulation
        };
        
        const simCanonical = await buildKaminoRefreshAndLiquidateIxsCanonical(simConfig);
        
        // Build and sign simulation transaction
        const bh = await connection.getLatestBlockhash();
        const simMsg = new TransactionMessage({
          payerKey: signer.publicKey,
          recentBlockhash: bh.blockhash,
          instructions: simCanonical.instructions,
        });
        const simCompiledMsg = simMsg.compileToLegacyMessage();
        const simTx = new VersionedTransaction(simCompiledMsg);
        simTx.sign([signer]);
        
        // Estimate seized collateral via account-delta approach
        const seizedCollateralBaseUnits = await estimateSeizedCollateralDeltaBaseUnits({
          connection,
          liquidator: signer.publicKey,
          collateralMint: withdrawCollateralMint,
          simulateTx: simTx,
          instructionLabels: simCanonical.labels,
        });
        
        console.log(`[Executor] Estimated seized: ${seizedCollateralBaseUnits} base units`);
        
        // Apply safety haircut
        const haircutBps = Number(process.env.SWAP_IN_HAIRCUT_BPS ?? 100);
        const haircutMultiplier = 10000n - BigInt(haircutBps);
        const inAmountBaseUnits = (seizedCollateralBaseUnits * haircutMultiplier) / 10000n;
        
        console.log(`[Executor] After ${haircutBps} bps haircut: ${inAmountBaseUnits} base units`);
        
        // Build Jupiter swap
        const slippageBps = Number(process.env.SWAP_SLIPPAGE_BPS ?? 100);
        const swapResult = await buildJupiterSwapIxs({
          inputMint: collateralMint,
          outputMint: repayMint,
          inAmountBaseUnits,
          slippageBps,
          userPubkey: signer.publicKey,
          connection,
        });
        
        // Collect all swap instructions
        swapInstructions = [
          ...swapResult.setupIxs,
          ...swapResult.swapIxs,
          ...swapResult.cleanupIxs,
        ];
        
        console.log(`[Executor] Built ${swapInstructions.length} swap instruction(s)`);
        
        if (swapResult.estimatedOutAmountBaseUnits) {
          const repayDecimals = plan.repayDecimals ?? 6;
          const estimatedOutUi = formatBaseUnitsToUiString(swapResult.estimatedOutAmountBaseUnits, repayDecimals);
          console.log(`[Executor]   Estimated output: ${estimatedOutUi} ${repayMint.toBase58().slice(0, 8)}`);
        }
        
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        
        // Check if it's a 6016 ObligationHealthy soft failure
        // Re-throw this special error so it can be caught by the parent function
        if (errMsg === 'OBLIGATION_HEALTHY') {
          console.error('[Executor] ℹ️  6016 ObligationHealthy detected during seized-delta estimation');
          console.error('[Executor] Skipping this plan and continuing with next cycle.\n');
          throw new Error('OBLIGATION_HEALTHY');
        }
        
        console.error('[Executor] Failed to estimate seized collateral or build swap:', errMsg);
        
        const enableFallback = (process.env.SWAP_SIZING_FALLBACK_ENABLED ?? 'true') === 'true';
        
        if (enableFallback) {
          console.warn('[Executor] ⚠️  FALLBACK: Seized-delta sizing failed, proceeding with liquidation-only');
          console.warn(`[Executor]   Error: ${err instanceof Error ? err.message : String(err)}`);
        } else {
          throw new Error(
            `Swap required but sizing failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    } else {
      console.log('[Executor] useRealSwapSizing=false, skipping swap (dry-run/test mode)');
    }
  }
  
  // Step 3: Build final canonical transaction with swap (if generated)
  const finalConfig = {
    ...canonicalConfig,
    swap: swapInstructions.length > 0 ? { instructions: swapInstructions } : undefined,
  };
  
  const finalCanonical = await buildKaminoRefreshAndLiquidateIxsCanonical(finalConfig);
  
  return {
    setupIxs: finalCanonical.setupIxs,
    setupLabels: finalCanonical.setupLabels,
    ixs: finalCanonical.instructions,
    labels: finalCanonical.labels,
    metadata: {
      repayMint,
      collateralMint,
      withdrawCollateralMint,
      hasFarmsRefresh,
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
    const minDelayMs = Number(env.SCHEDULED_MIN_LIQUIDATION_DELAY_MS ?? 0);
    const ttlGraceMs = Number(env.TTL_GRACE_MS ?? 60_000);
    const ttlUnknownPasses = (env.TTL_UNKNOWN_PASSES ?? 'true') === 'true';
    const forceIncludeLiquidatable = (env.SCHED_FORCE_INCLUDE_LIQUIDATABLE ?? 'true') === 'true';

    console.log('[Executor] Filter thresholds:');
    console.log(`  EXEC_MIN_EV: ${minEv}`);
    console.log(`  EXEC_MAX_TTL_MIN: ${maxTtlMin}`);
    console.log(`  TTL_GRACE_MS: ${ttlGraceMs}`);
    console.log(`  TTL_UNKNOWN_PASSES: ${ttlUnknownPasses}`);
    console.log(`  SCHED_FORCE_INCLUDE_LIQUIDATABLE: ${forceIncludeLiquidatable}`);

    const plans = loadPlans();
    if (!Array.isArray(plans) || plans.length === 0) {
      console.log('No plans available. Ensure data/tx_queue.json exists (PR10/PR11).');
      return { status: 'no-plans' };
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

  // Multi-attempt executor: try multiple candidates per tick
  const maxAttempts = Number(process.env.BOT_MAX_ATTEMPTS_PER_CYCLE ?? 10);
  console.log(`[Executor] Selected ${candidates.length} eligible plans, attempting up to ${maxAttempts}`);

  for (let attemptIdx = 0; attemptIdx < Math.min(maxAttempts, candidates.length); attemptIdx++) {
    const target = candidates[attemptIdx];
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
  let ixs: TransactionInstruction[];
  let labels: string[];
  let metadata: { hasFarmsRefresh: boolean };
  
  try {
    const result = await buildFullTransaction(target, signer, market, programId, {
      includeSwap: true,
      useRealSwapSizing,
    });
    setupIxs = result.setupIxs;
    setupLabels = result.setupLabels;
    ixs = result.ixs;
    labels = result.labels;
    metadata = result.metadata;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    
    // Check if it's OBLIGATION_HEALTHY error from buildFullTransaction
    if (errMsg === 'OBLIGATION_HEALTHY') {
      console.error('[Executor] ℹ️  6016 ObligationHealthy - plan skipped');
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
    console.log(`[Executor] Setup will be processed in a separate transaction to keep liquidation TX small`);
    
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
    
    // Build and sign setup transaction
    const setupBh = await connection.getLatestBlockhash();
    const setupMsg = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: setupBh.blockhash,
      instructions: setupIxs,
    });
    const setupCompiledMsg = setupMsg.compileToLegacyMessage();
    const setupTx = new VersionedTransaction(setupCompiledMsg);
    setupTx.sign([signer]);
    
    if (dry || !broadcast) {
      // Dry-run or non-broadcast mode: Simulate setup transaction for logging, then return without simulating liquidation
      console.log('[Executor] Simulating setup transaction...');
      const setupSim = await connection.simulateTransaction(setupTx);
      
      if (setupSim.value.err) {
        console.error('[Executor] Setup simulation error:', setupSim.value.err);
        if (setupSim.value.logs && setupSim.value.logs.length > 0) {
          console.error('\n[Executor] ═══ SETUP SIMULATION LOGS ═══');
          setupSim.value.logs.forEach((log, i) => {
            console.error(`  [${i}] ${log}`);
          });
          console.error('═══════════════════════════════════\n');
        }
        return { status: 'setup-sim-error' };
      }
      
      console.log('[Executor] Setup simulation success');
      console.log(`  CU used: ${setupSim.value.unitsConsumed ?? 'unknown'}`);
      console.log(`  Logs: ${setupSim.value.logs?.length ?? 0} entries`);
      
      // In dry-run mode, return 'setup-required' and skip liquidation simulation
      // Rationale: simulateTransaction does not persist ATA state, so liquidation would fail with AccountNotInitialized (3012)
      console.log('[Executor] Setup would be required in broadcast mode.');
      console.log('[Executor] Returning status "setup-required" without simulating liquidation (ATAs do not persist in simulation).\n');
      return { status: 'setup-required' };
      
    } else {
      // Broadcast setup transaction
      console.log('[Executor] Broadcasting setup transaction...');
      
      try {
        const setupAttempts = await sendWithBoundedRetry(
          connection,
          setupTx,
          signer,
          setupMsg,
          {
            maxAttempts: 2,
            cuLimit: 200_000, // Setup TX is small
            cuPrice: Number(process.env.EXEC_CU_PRICE ?? 0),
            cuLimitBumpFactor: 1.5,
            cuPriceBumpMicrolamports: 50000,
          }
        );
        
        console.log(formatAttemptResults(setupAttempts));
        
        const finalSetupAttempt = setupAttempts[setupAttempts.length - 1];
        
        if (finalSetupAttempt && finalSetupAttempt.success) {
          console.log('[Executor] ✅ Setup transaction confirmed successfully!');
          console.log(`[Executor] Signature: ${finalSetupAttempt.signature}`);
          console.log('[Executor] ATAs created. Liquidation will proceed in next cycle.');
          return { 
            status: 'setup-completed', 
            signature: finalSetupAttempt.signature
          };
        } else {
          console.error('[Executor] ❌ Setup transaction failed');
          return { status: 'setup-failed' };
        }
        
      } catch (err) {
        console.error('[Executor] Setup broadcast error:', err instanceof Error ? err.message : String(err));
        return { status: 'setup-error' };
      }
    }
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
  const msg = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: bh.blockhash,
    instructions: ixs,
  });
  const compiledMsg = msg.compileToLegacyMessage();
  const tx = new VersionedTransaction(compiledMsg);
  tx.sign([signer]);

  // COMPILED INSTRUCTION WINDOW VALIDATION
  // Validate the compiled transaction against expected canonical sequence
  // This catches any divergence between label-based validation and actual compiled message
  console.log('\n[Executor] Validating compiled instruction window...');
  const validation = validateCompiledInstructionWindow(tx, metadata.hasFarmsRefresh);
  
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
      const attempts = await sendWithBoundedRetry(
        connection,
        tx,
        signer,
        msg, // Pass TransactionMessage before compilation
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
