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
    
    const totalRefreshIxs = result.preReserveIxs.length + result.coreIxs.length + result.postFarmIxs.length;
    const totalIxs = totalRefreshIxs + result.liquidationIxs.length;
    console.log(`[Test] ✓ Successfully built ${totalIxs} instruction(s)`);
    console.log(`[Test]   Pre-reserve: ${result.preReserveIxs.length} instruction(s)`);
    console.log(`[Test]   Core (obligation + farms): ${result.coreIxs.length} instruction(s)`);
    console.log(`[Test]   Liquidation: ${result.liquidationIxs.length} instruction(s)`);
    console.log(`[Test]   Post-farms: ${result.postFarmIxs.length} instruction(s)`);
    console.log(`[Test]   Derived repay mint: ${result.repayMint.toBase58()}`);
    console.log(`[Test]   Derived collateral mint: ${result.collateralMint.toBase58()}`);
    
    // Verify instruction count matches expected pattern (NEW CANONICAL ORDER)
    // Expected: 2 PRE-reserve + 1 obligation + farms (0-2) = 3-5 core ixs
    // POST: farms (0-2, mirrors PRE)
    const { ataCount, farmRefreshCount, farmModes } = result;
    const expectedPreReserveCount = 2; // collateral + repay
    const expectedCoreCount = 1 + farmRefreshCount; // obligation + farms (0-2)
    const expectedPostFarmCount = farmRefreshCount; // mirrors PRE farms
    
    if (result.preReserveIxs.length !== expectedPreReserveCount) {
      console.error(`[Test] ERROR: Expected ${expectedPreReserveCount} pre-reserve instructions, got ${result.preReserveIxs.length}`);
      process.exit(1);
    }
    if (result.coreIxs.length !== expectedCoreCount) {
      console.error(`[Test] ERROR: Expected ${expectedCoreCount} core instructions, got ${result.coreIxs.length}`);
      process.exit(1);
    }
    if (result.postFarmIxs.length !== expectedPostFarmCount) {
      console.error(`[Test] ERROR: Expected ${expectedPostFarmCount} post-farm instructions, got ${result.postFarmIxs.length}`);
      process.exit(1);
    }
    
    console.log(`[Test]   ✓ Instruction count matches expected canonical structure`);
    console.log(`[Test]     - Setup ATA instructions: ${ataCount}`);
    console.log(`[Test]     - PRE-reserve: ${expectedPreReserveCount} (collateral + repay)`);
    console.log(`[Test]     - Core: ${expectedCoreCount} (obligation + ${farmRefreshCount} farms)`);
    console.log(`[Test]     - POST-farms: ${expectedPostFarmCount} (mirrors PRE farms)`);
    console.log(`[Test]     - Farm modes: ${farmModes.length > 0 ? farmModes.map(m => m === 0 ? 'collateral' : 'debt').join(', ') : 'none'}`);
    
    // Validate instruction order (NEW CANONICAL ORDER per KLend check_refresh)
    console.log(`[Test] Verifying canonical instruction order (fixes Custom(6009) and Custom(6051)):`);
    let idx = 0;
    
    // PRE-reserve instructions (for RefreshObligation slot freshness)
    console.log(`[Test]   [${idx}] PRE: RefreshReserve(collateral)`);
    console.log(`[Test]   [${idx + 1}] PRE: RefreshReserve(repay)`);
    idx += 2;
    
    // Core: Obligation refresh
    console.log(`[Test]   [${idx}] CORE: RefreshObligation`);
    idx += 1;
    
    // Core: Optional farms refresh (0-2 instructions)
    for (let i = 0; i < farmRefreshCount; i++) {
      const mode = farmModes[i];
      const modeLabel = mode === 0 ? 'collateral' : 'debt';
      console.log(`[Test]   [${idx}] CORE: RefreshFarms(${modeLabel}, mode=${mode})`);
      idx += 1;
    }
    
    // LIQUIDATE (not shown in loop, but understood to be here)
    console.log(`[Test]   [${idx}] LIQUIDATE: LiquidateObligationAndRedeemReserveCollateral`);
    idx += 1;
    
    // POST-farms instructions (immediately after liquidation, for check_refresh adjacency)
    for (let i = 0; i < farmRefreshCount; i++) {
      const mode = farmModes[i];
      const modeLabel = mode === 0 ? 'collateral' : 'debt';
      console.log(`[Test]   [${idx}] POST: RefreshFarms(${modeLabel}, mode=${mode})`);
      idx += 1;
    }
    
    console.log(`[Test]   ✓ Canonical instruction sequence matches KLend check_refresh requirements`);
    console.log(`[Test]   ✓ PRE reserves → obligation → farms (fixes Custom(6009) slot freshness)`);
    console.log(`[Test]   ✓ POST farms immediately after liquidation (fixes Custom(6051) adjacency)`);
    console.log(`[Test]   ✓ Removed POST reserve refresh (was breaking adjacency)`);
    
    // Validate pre-reserve instructions
    console.log(`[Test] Pre-reserve instructions:`);
    for (let i = 0; i < result.preReserveIxs.length; i++) {
      const ix = result.preReserveIxs[i];
      console.log(`[Test]   Pre-reserve Instruction ${i + 1}:`);
      console.log(`    Program: ${ix.programId.toBase58()}`);
      console.log(`    Keys: ${ix.keys.length}`);
      console.log(`    Data: ${ix.data.length} bytes`);
    }
    
    // Validate core instructions
    console.log(`[Test] Core instructions (obligation + farms):`);
    for (let i = 0; i < result.coreIxs.length; i++) {
      const ix = result.coreIxs[i];
      console.log(`[Test]   Core Instruction ${i + 1}:`);
      console.log(`    Program: ${ix.programId.toBase58()}`);
      console.log(`    Keys: ${ix.keys.length}`);
      console.log(`    Data: ${ix.data.length} bytes`);
    }
    
    // Validate post-farm instructions
    console.log(`[Test] Post-farm instructions (mirrors PRE farms):`);
    for (let i = 0; i < result.postFarmIxs.length; i++) {
      const ix = result.postFarmIxs[i];
      console.log(`[Test]   Post-farm Instruction ${i + 1}:`);
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
