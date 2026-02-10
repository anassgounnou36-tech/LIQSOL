import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, VersionedTransaction, TransactionMessage, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { buildKaminoFlashloanIxs } from '../flashloan/kaminoFlashloan.js';
import { buildKaminoLiquidationIxs } from '../kamino/liquidationBuilder.js';
import { buildJupiterSwapIxs } from './swapBuilder.js';
import { buildComputeBudgetIxs } from '../execution/computeBudget.js';
import { loadEnv } from '../config/env.js';
import { normalizeWslPath } from '../utils/path.js';
import { resolveMint } from '../utils/mintResolve.js';
import { sendWithBoundedRetry, formatAttemptResults } from './broadcastRetry.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';

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
 */
async function buildFullTransaction(
  plan: FlashloanPlan,
  connection: Connection,
  signer: Keypair,
  market: PublicKey,
  programId: PublicKey,
  opts: { includeSwap?: boolean; useRealSwapSizing?: boolean } = {}
): Promise<TransactionInstruction[]> {
  const ixs: TransactionInstruction[] = [];
  
  // Get env for config
  const cuLimit = Number(process.env.EXEC_CU_LIMIT ?? 600_000);
  const cuPrice = Number(process.env.EXEC_CU_PRICE ?? 0);
  
  // 1) ComputeBudget instructions
  const computeIxs = buildComputeBudgetIxs({
    cuLimit,
    cuPriceMicroLamports: cuPrice,
  });
  ixs.push(...computeIxs);
  
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
  
  // 3) Liquidation refresh + repay/seize (PR62: derives reserves from obligation)
  // Build with obligation pubkey only - reserves are derived from on-chain data
  let repayMintPreference: PublicKey | undefined;
  if (plan.repayMint) {
    try {
      repayMintPreference = resolveMint(plan.repayMint);
    } catch (err) {
      console.error(
        `[Executor] Failed to resolve repayMint for plan ${plan.key} (obligation: ${plan.obligationPubkey}):`,
        err instanceof Error ? err.message : String(err)
      );
      throw err;
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
  });
  
  ixs.push(...liquidationResult.refreshIxs);
  ixs.push(...liquidationResult.liquidationIxs);
  
  // Get derived mints for downstream validation
  const { repayMint, collateralMint } = liquidationResult;
  
  // 4) Optional Jupiter swap (if collateral mint != repay mint)
  // Final PR: Real swap sizing via deterministic seized delta estimation (NO log parsing)
  if (opts.includeSwap && !collateralMint.equals(repayMint)) {
    console.log('[Executor] Swap required: collateral mint differs from repay mint');
    console.log(`[Executor]   Collateral: ${collateralMint.toBase58()}`);
    console.log(`[Executor]   Repay: ${repayMint.toBase58()}`);
    
    if (opts.useRealSwapSizing) {
      // Real swap sizing: simulate liquidation to estimate seized collateral using account-delta
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
        const seizedCollateralBaseUnits = await estimateSeizedCollateralDeltaBaseUnits({
          connection,
          liquidator: signer.publicKey,
          collateralMint,
          simulateTx: preSimTx,
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
        
        ixs.push(...allSwapIxs);
        
      } catch (err) {
        console.error('[Executor] Failed to estimate seized collateral or build swap:', err instanceof Error ? err.message : String(err));
        throw new Error(
          'Swap required but sizing or building failed. ' +
          'Cannot build transaction without knowing seized collateral amount. ' +
          `Collateral: ${collateralMint.toBase58()}, Repay: ${repayMint.toBase58()}, ` +
          `Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      
    } else {
      // Fallback: mock mode or skip swap (for backward compatibility)
      console.log('[Executor] useRealSwapSizing=false, skipping swap (dry-run/test mode)');
      // Don't add swap instructions - transaction will fail if actually broadcast
    }
  }
  
  // 5) FlashRepay
  ixs.push(flashloan.flashRepayIx);
  
  return ixs;
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

  const rpcUrl = env.RPC_PRIMARY || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

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
  
  // PR2: Build full transaction pipeline
  const ixs = await buildFullTransaction(target, connection, signer, market, programId, {
    includeSwap: true,
    useRealSwapSizing,
  });
  
  const buildMs = Date.now() - buildStart;
  console.log(`[Executor] Built ${ixs.length} instructions in ${buildMs}ms`);

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
      console.error('[Executor] Simulation error:', sim.value.err);
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
