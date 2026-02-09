import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, VersionedTransaction, TransactionMessage, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { buildKaminoFlashloanIxs } from '../flashloan/kaminoFlashloan.js';
import { buildKaminoLiquidationIxs } from '../kamino/liquidationBuilder.js';
import { buildJupiterSwapIxs } from './swapBuilder.js';
import { buildComputeBudgetIxs } from '../execution/computeBudget.js';
import { loadEnv } from '../config/env.js';
import { normalizeWslPath } from '../utils/path.js';
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
  ttlMin?: number | string;
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
 */
async function buildFullTransaction(
  plan: FlashloanPlan,
  connection: Connection,
  signer: Keypair,
  market: PublicKey,
  programId: PublicKey,
  opts: { includeSwap?: boolean; mockSwap?: boolean } = {}
): Promise<TransactionInstruction[]> {
  const ixs: TransactionInstruction[] = [];
  
  // Get env for config
  const cuLimit = Number(process.env.EXEC_CU_LIMIT ?? 600_000);
  const cuPrice = Number(process.env.EXEC_CU_PRICE ?? 0);
  const slippageBps = Number(process.env.JUPITER_SLIPPAGE_BPS ?? 50);
  
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
  const liquidationResult = await buildKaminoLiquidationIxs({
    connection,
    marketPubkey: market,
    programId,
    obligationPubkey: new PublicKey(plan.obligationPubkey),
    liquidatorPubkey: signer.publicKey,
    // Optional: prefer USDC if available in borrows
    repayMintPreference: plan.repayMint ? new PublicKey(plan.repayMint) : undefined,
    repayAmountUi: plan.amountUi,
  });
  
  ixs.push(...liquidationResult.refreshIxs);
  ixs.push(...liquidationResult.liquidationIxs);
  
  // Get derived mints for downstream validation
  const { repayMint, collateralMint } = liquidationResult;
  
  // 4) Optional Jupiter swap (if collateral mint != repay mint)
  // PR62: fail-fast, no try-catch, use actual decimals
  if (opts.includeSwap && !collateralMint.equals(repayMint)) {
    // For now, we can't calculate exact seized collateral amount without simulating first
    // So we'll need to either:
    // 1) Skip swap in dry-run mode
    // 2) Use a reasonable estimate
    // 3) Fail if mockMode is not enabled
    
    if (!opts.mockSwap) {
      throw new Error(
        'Swap building requires mockMode=true for testing. ' +
        'Real swap amounts can only be determined after liquidation simulation. ' +
        `Collateral mint ${collateralMint.toBase58()} differs from repay mint ${repayMint.toBase58()}.`
      );
    }
    
    // In mock mode, return empty instructions
    const swapIxs = await buildJupiterSwapIxs({
      userPublicKey: signer.publicKey,
      fromMint: collateralMint.toBase58(),
      toMint: repayMint.toBase58(),
      amountUi: '1.0',
      fromDecimals: plan.collateralDecimals ?? 9,
      slippageBps,
      mockMode: true,
    });
    
    ixs.push(...swapIxs);
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

  const minEv = Number(env.EXEC_MIN_EV ?? 0);
  const maxTtlMin = Number(env.EXEC_MAX_TTL_MIN ?? 10);
  const minDelayMs = Number(env.SCHEDULED_MIN_LIQUIDATION_DELAY_MS ?? 0);

  const plans = loadPlans();
  if (!Array.isArray(plans) || plans.length === 0) {
    console.log('No plans available. Ensure data/tx_queue.json exists (PR10/PR11).');
    return { status: 'no-plans' };
  }

  const candidates = plans
    .filter(p => Number(p.ev ?? 0) > minEv)
    .filter(p => {
      const ttl = Number(p.ttlMin ?? Infinity);
      return ttl > 0 && ttl <= maxTtlMin;
    })
    .sort((a, b) => {
      // Primary: liquidationEligible (true first)
      const liqDiff = (b.liquidationEligible ? 1 : 0) - (a.liquidationEligible ? 1 : 0);
      if (liqDiff !== 0) return liqDiff;
      
      // Secondary: EV desc
      const evDiff = Number(b.ev ?? 0) - Number(a.ev ?? 0);
      if (evDiff !== 0) return evDiff;
      
      // Tertiary: TTL asc
      const ttlDiff = Number(a.ttlMin ?? Infinity) - Number(b.ttlMin ?? Infinity);
      if (ttlDiff !== 0) return ttlDiff;
      
      // Quaternary: hazard desc
      return Number(b.hazard ?? 0) - Number(a.hazard ?? 0);
    });

  if (candidates.length === 0) {
    console.log('No eligible candidates based on EV/TTL thresholds.');
    return { status: 'no-eligible' };
  }

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
  
  // PR2: Build full transaction pipeline
  const ixs = await buildFullTransaction(target, connection, signer, market, programId, {
    includeSwap: true,
    mockSwap: false,
  });
  
  const buildMs = Date.now() - buildStart;
  console.log(`[Executor] Built ${ixs.length} instructions in ${buildMs}ms`);

  // Build and sign transaction
  const bh = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: bh.blockhash,
    instructions: ixs,
  }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
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
    // Broadcast transaction
    console.log('[Executor] Broadcasting transaction...');
    const sendStart = Date.now();
    
    try {
      const signature = await connection.sendTransaction(tx, { skipPreflight: false });
      const sendMs = Date.now() - sendStart;
      
      console.log(`[Executor] Transaction sent in ${sendMs}ms`);
      console.log(`[Executor] Signature: ${signature}`);
      
      // Wait for confirmation
      const confirmation = await connection.confirmTransaction(signature, 'confirmed');
      
      if (confirmation.value.err) {
        console.error('[Executor] Transaction failed:', confirmation.value.err);
        return { status: 'tx-failed', signature };
      }
      
      console.log('[Executor] Transaction confirmed!');
      return { status: 'confirmed', signature };
      
    } catch (err) {
      console.error('[Executor] Broadcast error:', err instanceof Error ? err.message : String(err));
      return { status: 'broadcast-error' };
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
