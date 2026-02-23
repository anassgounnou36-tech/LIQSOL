#!/usr/bin/env node
import { PublicKey } from '@solana/web3.js';
import { pathToFileURL } from 'url';
import { loadEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { runInitialPipeline } from '../pipeline/runInitialPipeline.js';
import { startBotStartupScheduler, reloadWatchlistFromQueue } from '../scheduler/botStartupScheduler.js';

function parseMintAllowlistCsv(s?: string): string[] | undefined {
  if (!s) return undefined;
  const items = s.split(',').map(x => x.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

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

export async function startIntegratedLiveRunner(opts: {
  broadcast: boolean;
  refreshIntervalMs: number;
}): Promise<void> {
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

  // Display configuration
  console.log('Configuration:');
  console.log(`  RPC Endpoint: ${env.RPC_PRIMARY}`);
  console.log(`  Kamino Market: ${env.KAMINO_MARKET_PUBKEY}`);
  console.log(`  Kamino Program: ${env.KAMINO_KLEND_PROGRAM_ID}`);
  console.log(`  Yellowstone gRPC: ${env.YELLOWSTONE_GRPC_URL}`);

  // Parse broadcast mode
  const broadcast = opts.broadcast;
  console.log(`  Mode: ${broadcast ? 'BROADCAST (LIVE) 🔴' : 'DRY-RUN (SAFE)'}`);

  if (!broadcast) {
    console.log('\n⚠️  DRY-RUN MODE: Transactions will be simulated, not broadcast');
    console.log('   To enable broadcasting, set LIQSOL_BROADCAST=true in .env');
  } else {
    console.log('\n🔴 BROADCAST MODE ENABLED: Real transactions will be sent!');
  }

  const execAllowlist = parseMintAllowlistCsv(
    process.env.LIQSOL_EXEC_MINT_ALLOWLIST ?? process.env.LIQSOL_LIQ_MINT_ALLOWLIST
  );
  console.log(
    execAllowlist
      ? `  Execution allowlist: ${execAllowlist.length} mint(s)`
      : '  Execution allowlist: Disabled (all mints)'
  );

  // Parse refresh interval
  const refreshIntervalMs = opts.refreshIntervalMs;
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
    await runInitialPipeline({
      marketPubkey,
      programId,
      execAllowlistMints: execAllowlist,
      topN: Number(env.CAND_TOP ?? 50),
      nearThreshold: Number(env.CAND_NEAR ?? 1.02),
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
      await runInitialPipeline({
        marketPubkey,
        programId,
        execAllowlistMints: execAllowlist,
        topN: Number(env.CAND_TOP ?? 50),
        nearThreshold: Number(env.CAND_NEAR ?? 1.02),
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

async function main() {
  const env = loadEnv();
  await startIntegratedLiveRunner({
    broadcast: process.env.LIQSOL_BROADCAST === 'true',
    refreshIntervalMs: Number(env.LIVE_CANDIDATE_REFRESH_INTERVAL_MS ?? 120000),
  });
}

const isDirectRun =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  main().catch((err) => {
    console.error('[Live] FATAL ERROR:', err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error('[Live] Stack:', err.stack);
    process.exit(1);
  });
}
