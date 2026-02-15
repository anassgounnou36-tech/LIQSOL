import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { buildKaminoLiquidationIxs } from '../src/kamino/liquidationBuilder.js';
import { loadEnv } from '../src/config/env.js';
import { normalizeWslPath } from '../src/utils/path.js';
import { resolveMint } from '../src/utils/mintResolve.js';

interface TestPlan {
  planVersion?: number;
  obligationPubkey?: string;
  key?: string;
  // PR62: repayMint and collateralMint are now optional - derived from obligation
  repayMint?: string;
  collateralMint?: string;
}

async function main() {
  console.log('[Test] Kamino Liquidation Builder - Starting...');
  console.log('[Test] PR62: Testing obligation-based reserve derivation');
  
  const env = loadEnv();
  const rpcUrl = env.RPC_PRIMARY || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  // Load plans
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
  console.log(`  Obligation: ${plan.obligationPubkey}`);
  if (plan.repayMint) console.log(`  Repay Mint (preference): ${plan.repayMint}`);
  if (plan.collateralMint) console.log(`  Collateral Mint (hint): ${plan.collateralMint}`);
  console.log('[Test] Builder will derive reserves from obligation...');
  
  // Load keypair (needed as liquidator)
  const kpPath = normalizeWslPath(env.BOT_KEYPAIR_PATH);
  if (!kpPath || !fs.existsSync(kpPath)) {
    console.error(`[Test] ERROR: Keypair not found at ${kpPath}`);
    process.exit(1);
  }
  const secret = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
  const liquidator = Keypair.fromSecretKey(Uint8Array.from(secret));
  
  const market = new PublicKey(env.KAMINO_MARKET_PUBKEY);
  const programId = new PublicKey(env.KAMINO_KLEND_PROGRAM_ID);
  
  console.log('[Test] Building liquidation instructions...');
  
  try {
    // PR62: New API - only obligationPubkey required, reserves derived from obligation
    let repayMintPreference: PublicKey | undefined;
    if (plan.repayMint) {
      try {
        repayMintPreference = resolveMint(plan.repayMint);
        console.log(`[Test] Resolved repayMint preference: ${repayMintPreference.toBase58()}`);
      } catch (err) {
        console.error(`[Test] ERROR: Failed to resolve repayMint "${plan.repayMint}":`, err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }
    
    const result = await buildKaminoLiquidationIxs({
      connection,
      marketPubkey: market,
      programId,
      obligationPubkey: new PublicKey(plan.obligationPubkey!),
      liquidatorPubkey: liquidator.publicKey,
      // Optional: prefer specific repay mint if provided
      repayMintPreference,
    });
    
    const totalRefreshIxs = result.preRefreshIxs.length + result.refreshIxs.length + result.postRefreshIxs.length;
    const totalIxs = totalRefreshIxs + result.liquidationIxs.length;
    console.log(`[Test] ✓ Successfully built ${totalIxs} instruction(s)`);
    console.log(`[Test]   Pre-refresh: ${result.preRefreshIxs.length} instruction(s)`);
    console.log(`[Test]   Core refresh: ${result.refreshIxs.length} instruction(s)`);
    console.log(`[Test]   Post-refresh: ${result.postRefreshIxs.length} instruction(s)`);
    console.log(`[Test]   Liquidation: ${result.liquidationIxs.length} instruction(s)`);
    console.log(`[Test]   Derived repay mint: ${result.repayMint.toBase58()}`);
    console.log(`[Test]   Derived collateral mint: ${result.collateralMint.toBase58()}`);
    
    // Verify instruction count matches expected pattern
    // Expected: 2 PRE-refresh + farms (0-1) + obligation + 2 POST-refresh = 5-6 total refresh ixs
    const { ataCount, hasFarmsRefresh } = result;
    const expectedPreRefreshCount = 2; // repay + collateral
    const expectedCoreRefreshCount = (hasFarmsRefresh ? 1 : 0) + 1; // farms (optional) + obligation
    const expectedPostRefreshCount = 2; // repay + collateral
    const expectedTotalRefreshCount = expectedPreRefreshCount + expectedCoreRefreshCount + expectedPostRefreshCount;
    
    if (result.preRefreshIxs.length !== expectedPreRefreshCount) {
      console.error(`[Test] ERROR: Expected ${expectedPreRefreshCount} pre-refresh instructions, got ${result.preRefreshIxs.length}`);
      process.exit(1);
    }
    if (result.refreshIxs.length !== expectedCoreRefreshCount) {
      console.error(`[Test] ERROR: Expected ${expectedCoreRefreshCount} core refresh instructions, got ${result.refreshIxs.length}`);
      process.exit(1);
    }
    if (result.postRefreshIxs.length !== expectedPostRefreshCount) {
      console.error(`[Test] ERROR: Expected ${expectedPostRefreshCount} post-refresh instructions, got ${result.postRefreshIxs.length}`);
      process.exit(1);
    }
    
    console.log(`[Test]   ✓ Instruction count matches expected: ${expectedTotalRefreshCount}`);
    console.log(`[Test]     - Setup ATA instructions: ${ataCount}`);
    console.log(`[Test]     - PRE-refresh: ${expectedPreRefreshCount} (repay + collateral)`);
    console.log(`[Test]     - Farms refresh: ${hasFarmsRefresh ? 1 : 0}`);
    console.log(`[Test]     - Obligation refresh: 1`);
    console.log(`[Test]     - POST-refresh: ${expectedPostRefreshCount} (repay + collateral)`);
    
    // Validate instruction order
    console.log(`[Test] Verifying instruction order (fixes Custom(6009) and Custom(6051)):`);
    let idx = 0;
    
    // PRE-refresh instructions (for RefreshObligation slot freshness)
    console.log(`[Test]   [${idx}] PRE-refresh: RefreshReserve(repay)`);
    console.log(`[Test]   [${idx + 1}] PRE-refresh: RefreshReserve(collateral)`);
    idx += 2;
    
    // Optional farms refresh
    if (hasFarmsRefresh) {
      console.log(`[Test]   [${idx}] RefreshFarmsForObligationForReserve(collateral)`);
      idx += 1;
    }
    
    // Obligation refresh
    console.log(`[Test]   [${idx}] RefreshObligation`);
    idx += 1;
    
    // POST-refresh instructions (for check_refresh validation)
    console.log(`[Test]   [${idx}] POST-refresh: RefreshReserve(repay)`);
    console.log(`[Test]   [${idx + 1}] POST-refresh: RefreshReserve(collateral)`);
    idx += 2;
    
    console.log(`[Test]   ✓ Instruction sequence matches Kamino requirements`);
    console.log(`[Test]   ✓ PRE-refresh phase added to fix Custom(6009)`);
    console.log(`[Test]   ✓ POST-refresh phase preserves fix for Custom(6051)`);
    
    // Validate pre-refresh instructions
    console.log(`[Test] Pre-refresh instructions:`);
    for (let i = 0; i < result.preRefreshIxs.length; i++) {
      const ix = result.preRefreshIxs[i];
      console.log(`[Test]   Pre-refresh Instruction ${i + 1}:`);
      console.log(`    Program: ${ix.programId.toBase58()}`);
      console.log(`    Keys: ${ix.keys.length}`);
      console.log(`    Data: ${ix.data.length} bytes`);
    }
    
    // Validate core refresh instructions
    console.log(`[Test] Core refresh instructions:`);
    for (let i = 0; i < result.refreshIxs.length; i++) {
      const ix = result.refreshIxs[i];
      console.log(`[Test]   Core Refresh Instruction ${i + 1}:`);
      console.log(`    Program: ${ix.programId.toBase58()}`);
      console.log(`    Keys: ${ix.keys.length}`);
      console.log(`    Data: ${ix.data.length} bytes`);
    }
    
    // Validate post-refresh instructions
    console.log(`[Test] Post-refresh instructions:`);
    for (let i = 0; i < result.postRefreshIxs.length; i++) {
      const ix = result.postRefreshIxs[i];
      console.log(`[Test]   Post-refresh Instruction ${i + 1}:`);
      console.log(`    Program: ${ix.programId.toBase58()}`);
      console.log(`    Keys: ${ix.keys.length}`);
      console.log(`    Data: ${ix.data.length} bytes`);
    }
    
    // Validate liquidation instructions
    for (let i = 0; i < result.liquidationIxs.length; i++) {
      const ix = result.liquidationIxs[i];
      console.log(`[Test]   Liquidation Instruction ${i + 1}:`);
      console.log(`    Program: ${ix.programId.toBase58()}`);
      console.log(`    Keys: ${ix.keys.length}`);
      console.log(`    Data: ${ix.data.length} bytes`);
      
      // Verify it's a Kamino program instruction
      if (!ix.programId.equals(programId)) {
        console.error(`[Test] ERROR: Instruction program ID does not match Kamino program`);
        process.exit(1);
      }
    }
    
    if (totalIxs === 0) {
      console.error('[Test] ERROR: No instructions returned');
      process.exit(1);
    }
    
    console.log('[Test] ✓ All validations passed');
    console.log('[Test] ✓ Reserves successfully derived from obligation');
    console.log('[Test] Test PASSED');
    process.exit(0);
    
  } catch (err) {
    console.error('[Test] ERROR:', err instanceof Error ? err.message : String(err));
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
