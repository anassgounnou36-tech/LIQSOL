#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';
import { loadEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { buildCandidates } from '../pipeline/buildCandidates.js';
import { buildQueue } from '../pipeline/buildQueue.js';
import { startBotStartupScheduler, reloadWatchlistFromQueue } from '../scheduler/botStartupScheduler.js';
import { SOL_MINT, USDC_MINT } from '../constants/mints.js';

/**
 * Professional Integrated Live Runner
 * 
 * One-command solution that:
 * 1. Ensures data/obligations.jsonl exists
 * 2. Builds/refreshes candidates.json and tx_queue.json initially
 * 3. Starts listeners + scheduler (single init)
 * 4. Periodically rebuilds candidates + queue
 * 5. Runs continuously with event-driven execution
 * 
 * Usage:
 *   npm run bot:live        # Unix/Linux/Mac
 *   npm run bot:live:wsl    # Windows via WSL
 * 
 * Environment variables:
 *   - All standard bot variables (RPC, Yellowstone, Kamino, etc.)
 *   - LIVE_CANDIDATE_REFRESH_INTERVAL_MS: Refresh interval (default: 120000 = 2min)
 *   - LIQSOL_BROADCAST: Set to 'true' for live broadcasting
 */

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  LIQSOL Bot - Professional Live Runner        ║');
  console.log('║  Integrated Candidate + Queue + Executor      ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  // Load environment
  const env = loadEnv();

  // Parse configuration
  let marketPubkey: PublicKey;
  let programId: PublicKey;

  try {
    marketPubkey = new PublicKey(env.KAMINO_MARKET_PUBKEY);
  } catch {
    logger.error({ pubkey: env.KAMINO_MARKET_PUBKEY }, 'Invalid KAMINO_MARKET_PUBKEY');
    process.exit(1);
  }

  try {
    programId = new PublicKey(env.KAMINO_KLEND_PROGRAM_ID);
  } catch {
    logger.error({ pubkey: env.KAMINO_KLEND_PROGRAM_ID }, 'Invalid KAMINO_KLEND_PROGRAM_ID');
    process.exit(1);
  }

  // Check if obligations.jsonl exists
  const obligationsPath = path.join(process.cwd(), 'data', 'obligations.jsonl');
  if (!fs.existsSync(obligationsPath)) {
    console.error('❌ ERROR: data/obligations.jsonl not found');
    console.error('');
    console.error('The live runner requires an obligation snapshot to build candidates.');
    console.error('Please run: npm run snapshot:obligations:wsl');
    console.error('');
    process.exit(1);
  }

  // Display configuration
  console.log('Configuration:');
  console.log(`  RPC Endpoint: ${env.RPC_PRIMARY}`);
  console.log(`  Kamino Market: ${env.KAMINO_MARKET_PUBKEY}`);
  console.log(`  Kamino Program: ${env.KAMINO_KLEND_PROGRAM_ID}`);
  console.log(`  Yellowstone gRPC: ${env.YELLOWSTONE_GRPC_URL}`);

  // Parse broadcast mode
  const broadcast = process.env.LIQSOL_BROADCAST === 'true';
  console.log(`  Mode: ${broadcast ? 'BROADCAST (LIVE) 🔴' : 'DRY-RUN (SAFE)'}`);

  if (!broadcast) {
    console.log('\n⚠️  DRY-RUN MODE: Transactions will be simulated, not broadcast');
    console.log('   To enable broadcasting, set LIQSOL_BROADCAST=true in .env');
  } else {
    console.log('\n🔴 BROADCAST MODE ENABLED: Real transactions will be sent!');
  }

  // Parse allowlist
  let allowlistMints: string[] = [SOL_MINT, USDC_MINT];
  if (env.LIQSOL_LIQ_MINT_ALLOWLIST !== undefined) {
    if (env.LIQSOL_LIQ_MINT_ALLOWLIST.length > 0) {
      allowlistMints = env.LIQSOL_LIQ_MINT_ALLOWLIST
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
    } else {
      allowlistMints = [];
    }
  }

  if (allowlistMints.length > 0) {
    console.log(`  Allowlist: ${allowlistMints.length} mint(s)`);
  } else {
    console.log('  Allowlist: Disabled (all mints)');
  }

  // Parse refresh interval
  const refreshIntervalMs = Number(env.LIVE_CANDIDATE_REFRESH_INTERVAL_MS) || 120_000;
  console.log(`  Candidate Refresh: ${(refreshIntervalMs / 1000).toFixed(0)}s\n`);

  // Set executor mode via env for scheduler
  if (broadcast) {
    process.env.EXECUTOR_BROADCAST = 'true';
    process.env.LIQSOL_BROADCAST = 'true';
  } else {
    process.env.EXECUTOR_BROADCAST = 'false';
    process.env.LIQSOL_BROADCAST = 'false';
  }

  // Initial build: candidates + queue
  console.log('[Live] Building initial candidates and queue...\n');

  try {
    // Build candidates from obligations.jsonl
    await buildCandidates({
      marketPubkey,
      programId,
      allowlistMints: allowlistMints.length > 0 ? allowlistMints : undefined,
      topN: Number(env.CAND_TOP ?? 50),
      nearThreshold: Number(env.CAND_NEAR ?? 1.02),
    });

    // Build queue from candidates.json (uses replace mode by default)
    await buildQueue({
      flashloanMint: 'USDC',
    });

    console.log('\n[Live] ✅ Initial pipeline complete\n');
  } catch (err) {
    console.error('[Live] ❌ Failed to build initial candidates/queue:', err);
    console.error('');
    if (err instanceof Error) {
      console.error(err.stack);
    }
    process.exit(1);
  }

  // Start scheduler with listeners (single initialization)
  console.log('[Live] Starting scheduler with Yellowstone listeners...\n');

  try {
    // Start the scheduler (non-blocking, runs in background)
    startBotStartupScheduler().catch((err) => {
      console.error('[Live] Scheduler error:', err);
      process.exit(1);
    });
  } catch (err) {
    console.error('[Live] Failed to start scheduler:', err);
    process.exit(1);
  }

  // Set up periodic candidate/queue refresh with mutex
  console.log(`[Live] Setting up periodic refresh (${(refreshIntervalMs / 1000).toFixed(0)}s)...\n`);

  let refreshInProgress = false; // Mutex to prevent overlapping refreshes

  setInterval(async () => {
    if (refreshInProgress) {
      console.info('[Live] Refresh skipped: previous refresh still in progress');
      return;
    }
    
    refreshInProgress = true;
    console.log('[Live] ═══ PERIODIC REFRESH START ═══');

    try {
      // Rebuild candidates from obligations.jsonl
      await buildCandidates({
        marketPubkey,
        programId,
        allowlistMints: allowlistMints.length > 0 ? allowlistMints : undefined,
        topN: Number(env.CAND_TOP ?? 50),
        nearThreshold: Number(env.CAND_NEAR ?? 1.02),
      });

      // Rebuild queue from candidates.json (uses replace mode by default)
      await buildQueue({
        flashloanMint: 'USDC',
      });

      // Reload watchlist to update subscriptions with new queue
      await reloadWatchlistFromQueue();

      console.log('[Live] ✅ Periodic refresh complete');
    } catch (err) {
      console.error('[Live] ⚠️  Periodic refresh failed (will retry next cycle):', err);
    } finally {
      refreshInProgress = false;
    }

    console.log('[Live] ═══ PERIODIC REFRESH END ═══\n');
  }, refreshIntervalMs);

  logger.info('Live runner active - press Ctrl+C to stop');

  // Graceful shutdown handlers
  process.on('SIGINT', () => {
    console.log('\n[Live] Shutting down gracefully...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[Live] Shutting down gracefully...');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[Live] FATAL ERROR:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error('[Live] Stack:', err.stack);
  }
  process.exit(1);
});
