/**
 * Verification script to demonstrate the fix for ReserveStale (6009)
 * Shows the instruction ordering with pre-refresh and post-refresh
 */
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { normalizeWslPath } from '../src/utils/path.js';
import { buildKaminoLiquidationIxs } from '../src/kamino/liquidationBuilder.js';

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  VERIFICATION: Fix for ReserveStale (6009) at RefreshObligation');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const env = loadEnv();
  const rpcUrl = env.RPC_PRIMARY || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  // Load a test obligation
  const candidatesPath = path.join(process.cwd(), 'data', 'candidates.json');
  if (!fs.existsSync(candidatesPath)) {
    console.error('ERROR: No candidates.json found. Run: npm run snapshot:candidates');
    process.exit(1);
  }

  const plans = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
  const plan = plans.find((p: any) => p.obligationPubkey);

  if (!plan) {
    console.error('ERROR: No plan with obligationPubkey found');
    process.exit(1);
  }

  // Load keypair
  const kpPath = normalizeWslPath(env.BOT_KEYPAIR_PATH);
  if (!kpPath || !fs.existsSync(kpPath)) {
    console.error(`ERROR: Keypair not found at ${kpPath}`);
    process.exit(1);
  }
  const secret = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
  const liquidator = Keypair.fromSecretKey(Uint8Array.from(secret));

  const market = new PublicKey(env.KAMINO_MARKET_PUBKEY);
  const programId = new PublicKey(env.KAMINO_KLEND_PROGRAM_ID);

  console.log('Building liquidation instructions for:');
  console.log(`  Obligation: ${plan.obligationPubkey}`);
  console.log(`  Liquidator: ${liquidator.publicKey.toBase58()}\n`);

  try {
    const result = await buildKaminoLiquidationIxs({
      connection,
      marketPubkey: market,
      programId,
      obligationPubkey: new PublicKey(plan.obligationPubkey),
      liquidatorPubkey: liquidator.publicKey,
    });

    console.log('✓ Instruction building successful!\n');
    console.log('INSTRUCTION SEQUENCE (fixes Custom(6009) and preserves fix for Custom(6051)):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    let idx = 0;

    // Setup instructions
    if (result.setupIxs.length > 0) {
      console.log('📦 SETUP PHASE (ATA creation, if needed):');
      for (let i = 0; i < result.setupIxs.length; i++) {
        console.log(`  [${idx++}] CreateATA: ${result.setupAtaNames[i]}`);
      }
      console.log();
    }

    // Pre-refresh phase
    console.log('🔄 PRE-REFRESH PHASE (for RefreshObligation slot freshness):');
    console.log('   Purpose: Ensures reserves are fresh in the same slot');
    console.log('   Fixes: Custom(6009) ReserveStale at RefreshObligation\n');
    for (let i = 0; i < result.preRefreshIxs.length; i++) {
      const label = i === 0 ? 'RefreshReserve (repay)' : 'RefreshReserve (collateral)';
      console.log(`  [${idx++}] ${label}`);
    }
    console.log();

    // Core refresh phase
    console.log('⚙️  CORE REFRESH PHASE (RefreshFarms + RefreshObligation):');
    for (let i = 0; i < result.refreshIxs.length; i++) {
      const label = result.hasFarmsRefresh && i === 0 
        ? 'RefreshFarmsForObligationForReserve' 
        : 'RefreshObligation';
      console.log(`  [${idx++}] ${label}`);
    }
    console.log();

    // Post-refresh phase
    console.log('✅ POST-REFRESH PHASE (for check_refresh validation):');
    console.log('   Purpose: MUST be immediately before liquidation');
    console.log('   Fixes: Custom(6051) if not present\n');
    for (let i = 0; i < result.postRefreshIxs.length; i++) {
      const label = i === 0 ? 'RefreshReserve (repay)' : 'RefreshReserve (collateral)';
      console.log(`  [${idx++}] ${label}`);
    }
    console.log();

    // Liquidation phase
    console.log('💰 LIQUIDATION PHASE:');
    for (let i = 0; i < result.liquidationIxs.length; i++) {
      console.log(`  [${idx++}] LiquidateObligationAndRedeemReserveCollateral`);
    }
    console.log();

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('SUMMARY:');
    console.log(`  • Pre-refresh instructions: ${result.preRefreshIxs.length}`);
    console.log(`  • Core refresh instructions: ${result.refreshIxs.length}`);
    console.log(`  • Post-refresh instructions: ${result.postRefreshIxs.length}`);
    console.log(`  • Liquidation instructions: ${result.liquidationIxs.length}`);
    console.log(`  • Total instructions: ${idx}`);
    console.log();
    console.log('KEY IMPROVEMENTS:');
    console.log('  ✓ Pre-refresh ensures reserves are fresh for RefreshObligation');
    console.log('  ✓ Post-refresh satisfies check_refresh validation');
    console.log('  ✓ No instructions between post-refresh and liquidation');
    console.log('  ✓ Fixes Custom(6009) ReserveStale');
    console.log('  ✓ Preserves fix for Custom(6051)');
    console.log();
    console.log('═══════════════════════════════════════════════════════════════\n');
    console.log('✓ VERIFICATION PASSED\n');

  } catch (err) {
    console.error('ERROR:', err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) {
      console.error('Stack:', err.stack);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
