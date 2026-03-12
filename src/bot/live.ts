#!/usr/bin/env node
import { PublicKey } from '@solana/web3.js';
import { pathToFileURL } from 'url';
import { loadEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { RuntimeCoordinator } from '../live/runtimeCoordinator.js';
import { loadLiveRuntimeConfig } from '../live/runtimeConfig.js';

let shutdownInFlight: Promise<void> | null = null;

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
}): Promise<void> {
  shutdownInFlight = null;
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

  const runtimeConfig = loadLiveRuntimeConfig();
  console.log(`  Candidate Refresh: ${(runtimeConfig.rebuildIntervalMs / 1000).toFixed(0)}s\n`);

  // Set executor mode via env for scheduler
  if (broadcast) {
    process.env.EXECUTOR_BROADCAST = 'true';
    process.env.LIQSOL_BROADCAST = 'true';
  } else {
    process.env.EXECUTOR_BROADCAST = 'false';
    process.env.LIQSOL_BROADCAST = 'false';
  }

  const coordinator = new RuntimeCoordinator(
    { marketPubkey, programId, execAllowlistMints: execAllowlist },
    {
      rebuildIntervalMs: runtimeConfig.rebuildIntervalMs,
      heartbeatIntervalMs: runtimeConfig.heartbeatIntervalMs,
      tickDebounceMs: runtimeConfig.tickDebounceMs,
      queueEmptyLogIntervalMs: runtimeConfig.queueEmptyLogIntervalMs,
      promotionSummaryLogIntervalMs: runtimeConfig.promotionSummaryLogIntervalMs,
      realtimeEnabled: runtimeConfig.realtimeEnabled,
    },
  );

  console.log('[Live] Building initial candidates and queue via runtime coordinator...\n');
  await coordinator.runPeriodicRebuild('startup-rebuild');
  await coordinator.start({ broadcast });

  logger.info('Live runner active - press Ctrl+C to stop');

  async function shutdownFromSignal(signal: string): Promise<void> {
    if (shutdownInFlight) return shutdownInFlight;
    shutdownInFlight = (async () => {
      logger.info({ signal }, '[Live] Shutting down gracefully...');
      try {
        await coordinator.stop();
        logger.info('[Live] Shutdown complete');
        process.exitCode = 0;
      } catch (err) {
        logger.error({ err, signal }, '[Live] Graceful shutdown failed');
        process.exitCode = 1;
      } finally {
        process.exit();
      }
    })();
    return shutdownInFlight;
  }

  process.once('SIGINT', () => {
    void shutdownFromSignal('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdownFromSignal('SIGTERM');
  });
}

async function main() {
  await startIntegratedLiveRunner({
    broadcast: process.env.LIQSOL_BROADCAST === 'true',
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
