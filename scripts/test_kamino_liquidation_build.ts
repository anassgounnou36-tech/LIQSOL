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
    
    const totalIxs = result.refreshIxs.length + result.liquidationIxs.length;
    console.log(`[Test] ✓ Successfully built ${totalIxs} instruction(s)`);
    console.log(`[Test]   Refresh: ${result.refreshIxs.length} instruction(s)`);
    console.log(`[Test]   Liquidation: ${result.liquidationIxs.length} instruction(s)`);
    console.log(`[Test]   Derived repay mint: ${result.repayMint.toBase58()}`);
    console.log(`[Test]   Derived collateral mint: ${result.collateralMint.toBase58()}`);
    
    // Validate refresh instructions
    for (let i = 0; i < result.refreshIxs.length; i++) {
      const ix = result.refreshIxs[i];
      console.log(`[Test]   Refresh Instruction ${i + 1}:`);
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
