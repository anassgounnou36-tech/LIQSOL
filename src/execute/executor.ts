import fs from 'node:fs';
import path from 'node:path';
import { Keypair, VersionedTransaction, TransactionMessage, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getConnection } from '../solana/connection.js';
import { buildKaminoFlashloanIxs } from '../flashloan/kaminoFlashloan.js';
import { buildKaminoLiquidationIxs } from '../kamino/liquidationBuilder.js';
import { buildJupiterSwapIxs } from './swapBuilder.js';
import { buildComputeBudgetIxs } from '../execution/computeBudget.js';
import { loadEnv } from '../config/env.js';
import { normalizeWslPath } from '../utils/path.js';
import { resolveMintFlexible } from '../solana/mint.js';
import { sendWithBoundedRetry, formatAttemptResults } from './broadcastRetry.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';
import { isPlanComplete, getMissingFields } from '../scheduler/planValidation.js';

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
 * PR62: Build full transaction with liquidation pipeline
 * Order: ComputeBudget → flashBorrow → refresh → liquidation → optional swap → flashRepay
 * 
 * Changes in PR62:
 * - Liquidation builder now derives reserves from obligation (no collateralMint/repayMint required)
 * - Fail-fast on swap failure (no try-catch)
 * - Use actual amounts from liquidation result (no placeholders)
 * 
 * Final PR: Real swap sizing via simulation
 * - If swap needed, run pre-simulation to estimate seized collateral
 * - Build real Jupiter swap with estimated amount (minus haircut)
 * - Fail-fast if swap required but sizing unavailable
 * 
 * PART D: Now returns instruction labels alongside instructions for debugging
 */
async function buildFullTransaction(
  plan: FlashloanPlan,
  signer: Keypair,
  market: PublicKey,
  programId: PublicKey,
  opts: { includeSwap?: boolean; useRealSwapSizing?: boolean } = {}
): Promise<{ setupIxs: TransactionInstruction[]; setupLabels: string[]; ixs: TransactionInstruction[]; labels: string[] }> {
  const ixs: TransactionInstruction[] = [];
  const labels: string[] = [];
  const connection = getConnection();
  
  // Get env for config
  const cuLimit = Number(process.env.EXEC_CU_LIMIT ?? 600_000);
  const cuPrice = Number(process.env.EXEC_CU_PRICE ?? 0);
  
  // 1) ComputeBudget instructions
  const computeIxs = buildComputeBudgetIxs({
    cuLimit,
    cuPriceMicroLamports: cuPrice,
  });
  ixs.push(...computeIxs);
  
  // Push matching labels based on actual number of compute budget instructions
  labels.push('computeBudget:limit');
  if (computeIxs.length > 1) {
    labels.push('computeBudget:price');
  }
  
  // Current instruction index for flashloan
  const borrowIxIndex = ixs.length;
  
  // 2) FlashBorrow
  const mint = (plan.mint || 'USDC') as 'USDC' | 'SOL';
  const amountUi = String(plan.amountUi ?? plan.amountUsd ?? '100');
  
  const flashloan = await buildKaminoFlashloanIxs({
    connection,
    marketPubkey: market,
    programId,
    signer,
    mint,
    amountUi,
    borrowIxIndex,
  });
  
  ixs.push(flashloan.flashBorrowIx);
  labels.push('flashBorrow');
  
  // 3) Liquidation refresh + repay/seize (PR62: derives reserves from obligation)
  // Build with obligation pubkey only - reserves are derived from on-chain data
  // PR: Add strict preflight validation with expected reserve pubkeys from plan
  let repayMintPreference: PublicKey | undefined;
  let expectedRepayReservePubkey: PublicKey | undefined;
  let expectedCollateralReservePubkey: PublicKey | undefined;
  
  if (plan.repayMint) {
    try {
      repayMintPreference = resolveMintFlexible(plan.repayMint);
    } catch (err) {
      console.error(
        `[Executor] Failed to resolve repayMint for plan ${plan.key} (obligation: ${plan.obligationPubkey}):`,
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }
  }
  
  // PR: Parse expected reserve pubkeys from plan for validation
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
  
  const liquidationResult = await buildKaminoLiquidationIxs({
    connection,
    marketPubkey: market,
    programId,
    obligationPubkey: new PublicKey(plan.obligationPubkey),
    liquidatorPubkey: signer.publicKey,
    // Optional: prefer specific mint if provided
    repayMintPreference,
    repayAmountUi: plan.amountUi,
    // PR: Pass expected reserve pubkeys for strict preflight validation
    expectedRepayReservePubkey,
    expectedCollateralReservePubkey,
  });
  
  // TX Size Fix: Extract setupIxs and labels separately
  const setupIxs = liquidationResult.setupIxs;
  const setupLabels: string[] = [];
  const { hasFarmsRefresh, setupAtaNames } = liquidationResult;
  
  // Build labels for setup instructions (ATA creates) using names from builder
  for (const ataName of setupAtaNames) {
    setupLabels.push(`setup:ata:${ataName}`);
  }
  
  // Add labels for liquidation instructions (refreshIxs now contains NO ATA creates)
  ixs.push(...liquidationResult.refreshIxs);
  
  // Label refresh instructions (NO ATA labels needed here anymore)
  
  // Reserve refreshes in the order they appear in refreshIxs:
  // PRE-refresh phase (first 2): repay:pre, collateral:pre
  // Then farms refresh (optional)
  // Then obligation refresh
  // POST-refresh phase (last 2): repay:post, collateral:post
  
  // First 2 reserve refreshes (PRE-refresh phase)
  labels.push('refreshReserve:repay:pre');
  labels.push('refreshReserve:collateral:pre');
  
  // Farms refresh (optional, after PRE reserve refreshes)
  if (hasFarmsRefresh) {
    labels.push('refreshFarms');
  }
  
  // Obligation refresh (after farms refresh)
  labels.push('refreshObligation');
  
  // Last 2 reserve refreshes (POST-refresh phase)
  labels.push('refreshReserve:repay:post');
  labels.push('refreshReserve:collateral:post');
  
  ixs.push(...liquidationResult.liquidationIxs);
  labels.push('liquidate');
  
  // Get derived mints for downstream validation
  const { repayMint, collateralMint, withdrawCollateralMint } = liquidationResult;
  
  // 4) Optional Jupiter swap (if collateral mint != repay mint)
  // Final PR: Real swap sizing via deterministic seized delta estimation (NO log parsing)
  // NOTE: Use withdrawCollateralMint for seized-delta estimation (actual redemption mint)
  // but collateralMint for swap (liquidity mint)
  if (opts.includeSwap && !collateralMint.equals(repayMint)) {
    console.log('[Executor] Swap required: collateral mint differs from repay mint');
    console.log(`[Executor]   Collateral (liquidity): ${collateralMint.toBase58()}`);
    console.log(`[Executor]   Collateral (redemption): ${withdrawCollateralMint.toBase58()}`);
    console.log(`[Executor]   Repay: ${repayMint.toBase58()}`);
    
    // FIX: Gate seized-delta simulation behind ATA setup
    // If setupIxs exist, ATAs are missing. Skip swap sizing and return setup instructions.
    // Setup will be handled in runDryExecutor (lines 551-651).
    // Next cycle (after ATAs are created), sizing will proceed normally.
    if (setupIxs.length > 0) {
      console.log('[Executor] ⚠️  Swap sizing skipped: Setup required (ATAs missing)');
      console.log('[Executor] Setup transaction must be sent first. Swap sizing will run in next cycle.');
      // Skip swap sizing entirely - return instructions without swap
      // The setup handling logic in runDryExecutor will handle the setup transaction
    } else if (opts.useRealSwapSizing) {
      // Real swap sizing: simulate liquidation to estimate seized collateral using account-delta
      // Only proceed when all ATAs exist (setupIxs.length === 0)
      console.log('[Executor] Using REAL swap sizing via deterministic seized-delta estimation...');
      
      // Import seized delta estimator
      const { estimateSeizedCollateralDeltaBaseUnits } = await import('./seizedDeltaEstimator.js');
      const { formatBaseUnitsToUiString } = await import('./swapBuilder.js');
      
      // Build pre-simulation transaction (everything up to and including liquidation)
      // At this point ixs contains: ComputeBudget + FlashBorrow + Refresh + Liquidation
      const preSimIxs = [...ixs];
      
      try {
        // Build pre-sim tx for account-delta estimation
        const bh = await connection.getLatestBlockhash();
        const msg = new TransactionMessage({
          payerKey: signer.publicKey,
          recentBlockhash: bh.blockhash,
          instructions: preSimIxs,
        });
        const compiledMsg = msg.compileToLegacyMessage();
        const preSimTx = new VersionedTransaction(compiledMsg);
        preSimTx.sign([signer]);
        
        // Estimate seized collateral via account-delta approach (NO log parsing)
        // IMPORTANT: Use withdrawCollateralMint (actual redemption mint), not collateralMint (liquidity mint)
        const seizedCollateralBaseUnits = await estimateSeizedCollateralDeltaBaseUnits({
          connection,
          liquidator: signer.publicKey,
          collateralMint: withdrawCollateralMint, // Use redemption mint for ATA monitoring
          simulateTx: preSimTx,
          instructionLabels: labels, // Pass labels for diagnostic instruction map on failure
        });
        
        console.log(`[Executor] Estimated seized: ${seizedCollateralBaseUnits} base units`);
        
        // Apply safety haircut (SWAP_IN_HAIRCUT_BPS)
        const haircutBps = Number(process.env.SWAP_IN_HAIRCUT_BPS ?? 100);
        const haircutMultiplier = 10000n - BigInt(haircutBps);
        const inAmountBaseUnits = (seizedCollateralBaseUnits * haircutMultiplier) / 10000n;
        
        console.log(`[Executor] After ${haircutBps} bps haircut: ${inAmountBaseUnits} base units`);
        
        // Format for logging only
        const collateralDecimals = plan.collateralDecimals ?? 9;
        const seizedUi = formatBaseUnitsToUiString(inAmountBaseUnits, collateralDecimals);
        console.log(`[Executor] Building Jupiter swap for ${seizedUi} ${collateralMint.toBase58().slice(0, 8)}...`);
        
        // Build real Jupiter swap with base-units API (NO UI strings, NO Number conversions)
        const slippageBps = Number(process.env.SWAP_SLIPPAGE_BPS ?? 100);
        const swapResult = await buildJupiterSwapIxs({
          inputMint: collateralMint,
          outputMint: repayMint,
          inAmountBaseUnits, // bigint, NO conversion
          slippageBps,
          userPubkey: signer.publicKey,
          connection,
        });
        
        // Collect all swap instructions
        const allSwapIxs = [
          ...swapResult.setupIxs,
          ...swapResult.swapIxs,
          ...swapResult.cleanupIxs,
        ];
        
        console.log(`[Executor] Built ${allSwapIxs.length} swap instruction(s) (${swapResult.setupIxs.length} setup, ${swapResult.swapIxs.length} swap, ${swapResult.cleanupIxs.length} cleanup)`);
        
        if (swapResult.estimatedOutAmountBaseUnits) {
          const repayDecimals = plan.repayDecimals ?? 6;
          const estimatedOutUi = formatBaseUnitsToUiString(swapResult.estimatedOutAmountBaseUnits, repayDecimals);
          console.log(`[Executor]   Estimated output: ${estimatedOutUi} ${repayMint.toBase58().slice(0, 8)}`);
        }
        
        // Add labels for swap instructions
        ixs.push(...allSwapIxs);
        for (let i = 0; i < swapResult.setupIxs.length; i++) {
          labels.push(`swap:setup:${i}`);
        }
        for (let i = 0; i < swapResult.swapIxs.length; i++) {
          labels.push(`swap:${i}`);
        }
        for (let i = 0; i < swapResult.cleanupIxs.length; i++) {
          labels.push(`swap:cleanup:${i}`);
        }
        
      } catch (err) {
        console.error('[Executor] Failed to estimate seized collateral or build swap:', err instanceof Error ? err.message : String(err));
        
        // Fallback behavior: Proceed with liquidation-only (no swap)
        // This allows the bot to continue running 24/7 even when swap sizing fails
        const enableFallback = (process.env.SWAP_SIZING_FALLBACK_ENABLED ?? 'true') === 'true';
        
        if (enableFallback) {
          console.warn('[Executor] ⚠️  FALLBACK: Seized-delta sizing failed, proceeding with liquidation-only');
          console.warn('[Executor] Swap will be skipped. Seized collateral will remain in destination ATA.');
          console.warn(`[Executor]   Collateral: ${collateralMint.toBase58()}`);
          console.warn(`[Executor]   Repay: ${repayMint.toBase58()}`);
          console.warn(`[Executor]   Error: ${err instanceof Error ? err.message : String(err)}`);
          console.warn('[Executor] Bot will continue with next cycle.');
          // Skip swap - transaction will execute liquidation only
          // The flashloan will still be repaid from the liquidator's repay token account
        } else {
          // Fail-fast mode (original behavior)
          throw new Error(
            'Swap required but sizing or building failed. ' +
            'Cannot build transaction without knowing seized collateral amount. ' +
            `Collateral: ${collateralMint.toBase58()}, Repay: ${repayMint.toBase58()}, ` +
            `Error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      
    } else {
      // Fallback: mock mode or skip swap (for backward compatibility)
      console.log('[Executor] useRealSwapSizing=false, skipping swap (dry-run/test mode)');
      // Don't add swap instructions - transaction will fail if actually broadcast
    }
  }
  
  // 5) FlashRepay
  ixs.push(flashloan.flashRepayIx);
  labels.push('flashRepay');
  
  return { setupIxs, setupLabels, ixs, labels };
}

interface ExecutorOpts {
  dry?: boolean;
  broadcast?: boolean;
}

// Exported API for scheduler
export async function runDryExecutor(opts?: ExecutorOpts): Promise<{ status: string; signature?: string } | void> {
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

  console.log(`[Executor] Selected ${candidates.length} eligible plans, executing up to maxInflight=1`);

  const target = candidates[0];
  
  // PR2: Validate plan version and required fields
  try {
    validatePlanVersion(target);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { status: 'invalid-plan' };
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
    console.error('[Executor]    Action: Regenerate tx_queue.json with: npm run test:scheduler:forecast');
    return { status: 'incomplete-plan' };
  }
  
  const now = Date.now();
  const createdAtMs = Number(target.createdAtMs ?? 0);
  const ageMs = createdAtMs ? (now - createdAtMs) : Infinity;
  if (minDelayMs > 0 && ageMs < minDelayMs) {
    console.log(`Skipping due to SCHEDULED_MIN_LIQUIDATION_DELAY_MS (${minDelayMs}ms). Age: ${ageMs}ms`);
    return { status: 'min-delay' };
  }

  const kpPath = normalizeWslPath(env.BOT_KEYPAIR_PATH);
  if (!kpPath || !fs.existsSync(kpPath)) {
    console.error(`Keypair not found at ${kpPath}.`);
    return { status: 'no-keypair' };
  }
  const secret = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
  const signer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const market = new PublicKey(env.KAMINO_MARKET_PUBKEY || '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
  const programId = new PublicKey(env.KAMINO_KLEND_PROGRAM_ID || 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

  console.log('[Executor] Building full transaction...');
  const buildStart = Date.now();
  
  // Final PR: Use real swap sizing when not in mock/test mode
  const useRealSwapSizing = !dry; // Use real sizing for broadcast mode, skip for dry-run
  
  // PR2: Build full transaction pipeline (now returns setupIxs + ixs + labels)
  // Wrap in try/catch to handle swap sizing failures gracefully without crashing the bot
  let setupIxs: TransactionInstruction[];
  let setupLabels: string[];
  let ixs: TransactionInstruction[];
  let labels: string[];
  
  try {
    const result = await buildFullTransaction(target, signer, market, programId, {
      includeSwap: true,
      useRealSwapSizing,
    });
    setupIxs = result.setupIxs;
    setupLabels = result.setupLabels;
    ixs = result.ixs;
    labels = result.labels;
  } catch (err) {
    console.error('[Executor] ❌ Failed to build transaction:', err instanceof Error ? err.message : String(err));
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
        } as { status: string; signature?: string; [key: string]: unknown };
      } else {
        console.error('[Executor] All broadcast attempts failed');
        return { 
          status: 'broadcast-failed'
        } as { status: string; signature?: string; [key: string]: unknown };
      }
      
    } catch (err) {
      console.error('[Executor] Broadcast error:', err instanceof Error ? err.message : String(err));
      return { status: 'broadcast-error' } as { status: string; signature?: string; [key: string]: unknown };
    }
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
