import { startIntegratedLiveRunner } from './live.js';
import { loadEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';

/**
 * PR2: Bot run entrypoint with continuous loop
 * Integrates Yellowstone listeners, scheduler loop, and executor loop
 * Dry-run by default; broadcasting only with --broadcast flag
 */

interface BotRunOptions {
  broadcast?: boolean;
  maxInflight?: number;
  minEv?: number;
  maxAttemptsPerCycle?: number;
}

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'UnhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'UncaughtException');
});

function parseArgs(): BotRunOptions {
  const args = process.argv.slice(2);
  
  return {
    broadcast: args.includes('--broadcast') || ['true', '1', 'yes'].includes((process.env.LIQSOL_BROADCAST ?? '').toLowerCase()),
    maxInflight: Number(process.env.BOT_MAX_INFLIGHT ?? 1),
    minEv: Number(process.env.EXEC_MIN_EV ?? 0),
    maxAttemptsPerCycle: Number(process.env.BOT_MAX_ATTEMPTS_PER_CYCLE ?? 10),
  };
}

async function main() {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║  LIQSOL Bot - Kamino Liquidation Executor    ║');
  console.log('║  PR2: Real liquidation execution path        ║');
  console.log('╚═══════════════════════════════════════════════╝\n');
  
  // Load environment
  const env = loadEnv();
  
  // Parse options
  const opts = parseArgs();
  
  // Display configuration
  console.log('Configuration:');
  console.log(`  RPC Endpoint: ${env.RPC_PRIMARY}`);
  console.log(`  Kamino Market: ${env.KAMINO_MARKET_PUBKEY}`);
  console.log(`  Yellowstone gRPC: ${env.YELLOWSTONE_GRPC_URL}`);
  console.log(`  Mode: ${opts.broadcast ? 'BROADCAST (LIVE)' : 'DRY-RUN (SAFE)'}`);
  console.log(`  Max Inflight: ${opts.maxInflight}`);
  console.log(`  Min EV: ${opts.minEv}`);
  console.log(`  Max Attempts/Cycle: ${opts.maxAttemptsPerCycle}`);
  
  if (!opts.broadcast) {
    console.log('\n⚠️  DRY-RUN MODE: Transactions will be simulated, not broadcast');
    console.log('   To enable broadcasting, use: npm run bot:run -- --broadcast');
  } else {
    console.log('\n🔴 BROADCAST MODE ENABLED: Transactions will be sent to the network!');
  }
  
  // Set executor broadcast mode via env for scheduler to use
  // Note: SCHEDULER_ENABLE_DRYRUN controls whether executor runs at all (not the mode)
  if (opts.broadcast) {
    process.env.EXECUTOR_BROADCAST = 'true';
    process.env.LIQSOL_BROADCAST = 'true';
  } else {
    process.env.EXECUTOR_BROADCAST = 'false';
    process.env.LIQSOL_BROADCAST = 'false';
  }
  
  console.log('\n[Bot] Starting bot with scheduler and listeners...\n');
  
  // Start integrated live runner (snapshot + candidates + queue + scheduler/listeners)
  await startIntegratedLiveRunner({
    broadcast: opts.broadcast ?? false,
    refreshIntervalMs: Number(process.env.LIVE_CANDIDATE_REFRESH_INTERVAL_MS ?? 120000),
  });
  
  logger.info('Bot running - press Ctrl+C to stop');
  
  // Keep process alive
  process.on('SIGINT', () => {
    console.log('\n[Bot] Shutting down gracefully...');
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n[Bot] Shutting down gracefully...');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[Bot] FATAL ERROR:', err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error('[Bot] Stack:', err.stack);
  }
  process.exit(1);
});
