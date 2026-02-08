import { loadStartupSchedulerConfig } from './config/startupSchedulerConfig.js';
import { loadEnv } from '../config/env.js';
import { refreshQueue, loadQueue } from './txScheduler.js';
import { type TtlManagerParams } from '../predict/forecastTTLManager.js';
import { runDryExecutor } from '../execute/executor.js';
import { YellowstoneAccountListener } from '../monitoring/yellowstoneAccountListener.js';
import { YellowstonePriceListener } from '../monitoring/yellowstonePriceListener.js';
import { EventRefreshOrchestrator } from '../monitoring/eventRefreshOrchestrator.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { loadReserves, getMintsByOracle, type ReserveCache } from '../cache/reserveCache.js';
import { logger } from '../observability/logger.js';

function getEnvNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

function deriveObligationPubkeysFromQueue(): string[] {
  const q = loadQueue();
  return q.map(p => String(p.key)).filter(Boolean);
}

async function deriveOraclePubkeysFromReserves(env: any): Promise<{ oraclePubkeys: string[]; reserveCache: ReserveCache }> {
  const conn = new Connection(env.RPC_PRIMARY, 'confirmed');
  const market = new PublicKey(env.KAMINO_MARKET_PUBKEY);
  const reserves = await loadReserves(conn, market);
  const set = new Set<string>();
  for (const [, r] of reserves.byMint.entries()) {
    for (const pk of r.oraclePubkeys) {
      set.add(pk.toString());
    }
  }
  return { oraclePubkeys: Array.from(set), reserveCache: reserves };
}

// Initialize listeners and orchestrator for event-driven refresh
async function initRealtime(): Promise<EventRefreshOrchestrator> {
  const env = loadEnv();
  const grpcUrl = env.YELLOWSTONE_GRPC_URL;
  const token = env.YELLOWSTONE_X_TOKEN;

  const obligationPubkeys = deriveObligationPubkeysFromQueue();
  logger.info({ count: obligationPubkeys.length }, 'Derived obligation pubkeys from queue');

  const { oraclePubkeys, reserveCache } = await deriveOraclePubkeysFromReserves(env);
  logger.info({ count: oraclePubkeys.length }, 'Derived oracle pubkeys from reserves');

  // Build oracle→mint mapping for price listener
  const oracleToMints = new Map<string, string[]>();
  for (const oracle of oraclePubkeys) {
    const mints = getMintsByOracle(reserveCache, oracle);
    if (mints.length > 0) {
      oracleToMints.set(oracle, mints);
    }
  }
  logger.info({ uniqueOracles: oracleToMints.size }, 'Built oracle→mint mapping');

  const orchestrator = new EventRefreshOrchestrator({
    minHealthDelta: Number(process.env.MIN_HEALTH_DELTA ?? 0.01),
    minRefreshIntervalMs: Number(process.env.EVENT_MIN_REFRESH_INTERVAL_MS ?? 3000),
    batchLimit: Number(process.env.EVENT_REFRESH_BATCH_LIMIT ?? 50),
  });

  const accountListener = new YellowstoneAccountListener({
    grpcUrl,
    authToken: token,
    accountPubkeys: obligationPubkeys,
    reconnectMs: 5000,
    debounceMs: 150,
  });

  const priceListener = new YellowstonePriceListener({
    grpcUrl,
    authToken: token,
    oraclePubkeys,
    reconnectMs: 5000,
    debounceMs: 150,
  });

  accountListener.on('ready', info => logger.info(info, 'Account listener ready'));
  accountListener.on('account-update', ev => orchestrator.handleAccountUpdate(ev));
  accountListener.on('error', err => logger.error({ err }, 'Account listener error'));

  priceListener.on('ready', info => logger.info(info, 'Price listener ready'));
  priceListener.on('price-update', ev => {
    // Resolve mint from oracle pubkey using oracle→mint map
    const mints = oracleToMints.get(ev.oraclePubkey) ?? [];
    for (const mint of mints) {
      orchestrator.handlePriceUpdate({ ...ev, mint });
    }
  });
  priceListener.on('error', err => logger.error({ err }, 'Price listener error'));

  await accountListener.start();
  await priceListener.start();

  logger.info('Real-time listeners initialized and started');

  return orchestrator;
}

export async function startBotStartupScheduler(): Promise<void> {
  // Ensure env is loaded so scheduler flags are present
  loadEnv();
  loadStartupSchedulerConfig(); // load flags/env; no local assignment needed

  const ttlParams: TtlManagerParams = {
    forecastMaxAgeMs: getEnvNum('FORECAST_MAX_AGE_MS', 300_000),
    minRefreshIntervalMs: getEnvNum('SCHED_MIN_REFRESH_INTERVAL_MS', 60_000),
    ttlExpiredMarginMin: getEnvNum('SCHED_TTL_EXPIRED_MARGIN_MIN', 2),
    evDropPct: getEnvNum('SCHED_EV_DROP_PCT', 0.15),
    minEv: getEnvNum('SCHED_MIN_EV', 0),
  };

  // Initialize event-driven refresh (listeners + orchestrator). No local variable needed.
  await initRealtime();

  async function cycleOnce(): Promise<void> {
    console.log('\n[Scheduler] Cycle start');

    // Optional: keep a very infrequent periodic refresh as safety (disabled by default)
    if ((process.env.SCHEDULER_ENABLE_REFRESH ?? 'false') === 'true') {
      const updated = refreshQueue(ttlParams, []);
      console.log(`[Scheduler] Refresh complete: queue size ${updated.length}`);
    } else {
      console.log('[Scheduler] Event-driven refresh enabled (cron refresh disabled).');
    }

    if ((process.env.SCHEDULER_ENABLE_AUDIT ?? 'true') === 'true') {
      const queue = loadQueue();
      const total = queue.length;
      const active = queue.filter(p => Number(p.ttlMin ?? Infinity) > 0).length;
      const expired = total - active;
      console.log(`[Audit] Total: ${total} | Active: ${active} | Expired: ${expired}`);
      if (total > 0) {
        const top = [...queue]
          .sort((a, b) =>
            (Number(b.ev) - Number(a.ev)) ||
            (Number(a.ttlMin) - Number(b.ttlMin)) ||
            (Number(b.hazard) - Number(a.hazard))
          )
          .slice(0, 5)
          .map(p => ({ key: p.key, ev: Number(p.ev).toFixed(2), ttlMin: Number(p.ttlMin).toFixed(2), hazard: Number(p.hazard).toFixed(3) }));
        console.table(top);
      }
    }

    if ((process.env.SCHEDULER_ENABLE_DRYRUN ?? 'true') === 'true') {
      try {
        const res = await runDryExecutor({ dry: true });
        console.log('[Executor] Dry-run completed:', res?.status ?? 'ok');
      } catch (e) {
        console.warn('[Executor] Dry-run failed:', (e as Error).message);
      }
    }

    console.log('[Scheduler] Cycle end');
  }

  // Run initial cycle; rely on event-driven triggers afterwards
  await cycleOnce();

  // Keep a very slow heartbeat cycle for audit/logging (optional)
  const heartbeatMs = Number(process.env.SCHED_HEARTBEAT_INTERVAL_MS ?? 60000);
  setInterval(() => {
    cycleOnce().catch(err => console.error('[Scheduler] Cycle error:', err));
  }, heartbeatMs);
}

// CLI entry
(async () => {
  await startBotStartupScheduler();
})();
