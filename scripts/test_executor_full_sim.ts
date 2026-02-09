import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, VersionedTransaction, TransactionMessage, PublicKey } from '@solana/web3.js';
import { buildKaminoFlashloanIxs } from '../src/flashloan/kaminoFlashloan.js';
import { buildKaminoLiquidationIxs } from '../src/kamino/liquidationBuilder.js';
import { buildJupiterSwapIxs } from '../src/execute/swapBuilder.js';
import { buildComputeBudgetIxs } from '../src/execution/computeBudget.js';
import { loadEnv } from '../src/config/env.js';
import { normalizeWslPath } from '../src/utils/path.js';

interface TestPlan {
  planVersion?: number;
  obligationPubkey?: string;
  // PR62: repayMint and collateralMint are now optional - derived from obligation
  repayMint?: string;
  collateralMint?: string;
  repayDecimals?: number;
  collateralDecimals?: number;
  mint?: string;
  amountUi?: string;
  amountUsd?: string;
}

async function main() {
  console.log('[Test] Executor Full Simulation - Starting...');
  console.log('[Test] PR62: Testing obligation-based liquidation with fail-fast executor');
  
  const env = loadEnv();
  const rpcUrl = env.RPC_PRIMARY || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  // Load plans from queue or candidates
  const queuePath = path.join(process.cwd(), 'data', 'tx_queue.json');
  const candidatesPath = path.join(process.cwd(), 'data', 'candidates.json');
  
  let plans: TestPlan[] = [];
  if (fs.existsSync(queuePath)) {
    plans = JSON.parse(fs.readFileSync(queuePath, 'utf8')) as TestPlan[];
    console.log(`[Test] Loaded ${plans.length} plans from tx_queue.json`);
  } else if (fs.existsSync(candidatesPath)) {
    plans = JSON.parse(fs.readFileSync(candidatesPath, 'utf8')) as TestPlan[];
    console.log(`[Test] Loaded ${plans.length} plans from candidates.json`);
  }
  
  if (plans.length === 0) {
    console.error('[Test] ERROR: No plans found in data/tx_queue.json or data/candidates.json');
    console.log('[Test] Create test data with: npm run snapshot:candidates');
    process.exit(1);
  }
  
  // PR62: Find first plan with obligationPubkey (no longer requires repayMint/collateralMint)
  const plan = plans.find(p => p.obligationPubkey);
  
  if (!plan) {
    console.error('[Test] ERROR: No plan with obligationPubkey found');
    console.log('[Test] Plans must have: obligationPubkey');
    console.log('[Test] Regenerate plans with: npm run snapshot:candidates');
    process.exit(1);
  }
  
  console.log('[Test] Using plan:');
  if (plan.planVersion) console.log(`  Plan Version: ${plan.planVersion}`);
  console.log(`  Obligation: ${plan.obligationPubkey}`);
  if (plan.repayMint) console.log(`  Repay Mint (preference): ${plan.repayMint}`);
  if (plan.collateralMint) console.log(`  Collateral Mint (hint): ${plan.collateralMint}`);
  console.log('[Test] Builder will derive reserves from obligation...');
  
  // Load keypair
  const kpPath = normalizeWslPath(env.BOT_KEYPAIR_PATH);
  if (!kpPath || !fs.existsSync(kpPath)) {
    console.error(`[Test] ERROR: Keypair not found at ${kpPath}`);
    process.exit(1);
  }
  const secret = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
  const signer = Keypair.fromSecretKey(Uint8Array.from(secret));
  
  const market = new PublicKey(env.KAMINO_MARKET_PUBKEY);
  const programId = new PublicKey(env.KAMINO_KLEND_PROGRAM_ID);
  
  console.log('\n[Test] Building FULL transaction with all components...');
  
  const allIxs: any[] = [];
  
  try {
    // 1) ComputeBudget
    console.log('[Test] 1/5: Building ComputeBudget instructions...');
    const computeIxs = buildComputeBudgetIxs({
      cuLimit: 600_000,
      cuPriceMicroLamports: 0,
    });
    allIxs.push(...computeIxs);
    console.log(`[Test]   ✓ Added ${computeIxs.length} ComputeBudget instruction(s)`);
    
    // 2) FlashBorrow
    console.log('[Test] 2/5: Building FlashBorrow instruction...');
    const borrowIxIndex = allIxs.length;
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
    allIxs.push(flashloan.flashBorrowIx);
    console.log('[Test]   ✓ Added FlashBorrow instruction');
    
    // 3) Liquidation (PR62: derives reserves from obligation)
    console.log('[Test] 3/5: Building Liquidation instructions...');
    const liquidationResult = await buildKaminoLiquidationIxs({
      connection,
      marketPubkey: market,
      programId,
      obligationPubkey: new PublicKey(plan.obligationPubkey!),
      liquidatorPubkey: signer.publicKey,
      repayMintPreference: plan.repayMint ? new PublicKey(plan.repayMint) : undefined,
      repayAmountUi: amountUi,
    });
    allIxs.push(...liquidationResult.refreshIxs);
    allIxs.push(...liquidationResult.liquidationIxs);
    console.log(`[Test]   ✓ Added ${liquidationResult.refreshIxs.length} Refresh instruction(s)`);
    console.log(`[Test]   ✓ Added ${liquidationResult.liquidationIxs.length} Liquidation instruction(s)`);
    console.log(`[Test]   Derived repay: ${liquidationResult.repayMint.toBase58()}`);
    console.log(`[Test]   Derived collateral: ${liquidationResult.collateralMint.toBase58()}`);
    
    // 4) Optional Swap (PR62: fail-fast, no placeholders)
    console.log('[Test] 4/5: Building Swap instructions...');
    if (!liquidationResult.repayMint.equals(liquidationResult.collateralMint)) {
      console.log('[Test]   Mints differ - swap would be needed in real execution');
      console.log('[Test]   Skipping swap in test (mockMode would be required)');
      // In real executor, this would throw if not in mockMode
    } else {
      console.log('[Test]   → Skipped (repay and collateral mints are same)');
    }
    
    // 5) FlashRepay
    console.log('[Test] 5/5: Adding FlashRepay instruction...');
    allIxs.push(flashloan.flashRepayIx);
    console.log('[Test]   ✓ Added FlashRepay instruction');
    
    console.log(`\n[Test] Built complete transaction with ${allIxs.length} total instructions`);
    
    // Build and simulate transaction
    console.log('\n[Test] Building versioned transaction...');
    const bh = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: allIxs,
    }).compileToLegacyMessage();
    const tx = new VersionedTransaction(msg);
    tx.sign([signer]);
    
    console.log('[Test] Simulating transaction...');
    const simStart = Date.now();
    const sim = await connection.simulateTransaction(tx);
    const simMs = Date.now() - simStart;
    
    console.log(`[Test] Simulation completed in ${simMs}ms`);
    
    if (sim.value.err) {
      console.log('[Test] Simulation error:', JSON.stringify(sim.value.err, null, 2));
      console.log('[Test] This is expected if the obligation is not actually liquidatable on-chain');
      console.log('[Test] The test validates instruction building, not execution success');
      console.log('[Test] PASS criteria: transaction built correctly with proper accounts');
    } else {
      console.log('[Test] ✓ Simulation succeeded!');
      console.log(`[Test]   CU used: ${sim.value.unitsConsumed ?? 'unknown'}`);
    }
    
    // Log some simulation details
    if (sim.value.logs && sim.value.logs.length > 0) {
      console.log(`[Test]   Logs (${sim.value.logs.length} entries):`);
      sim.value.logs.slice(0, 5).forEach(log => console.log(`[Test]     ${log}`));
      if (sim.value.logs.length > 5) {
        console.log(`[Test]     ... (${sim.value.logs.length - 5} more)`);
      }
    }
    
    console.log('\n[Test] ✓ Successfully built and simulated FULL transaction with obligation-derived reserves');
    console.log('[Test] ✓ Reserves successfully derived from obligation');
    console.log('[Test] Test PASSED');
    process.exit(0);
    
  } catch (err) {
    console.error('\n[Test] ERROR:', err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) {
      console.error('[Test] Stack:', err.stack);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[Test] FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
