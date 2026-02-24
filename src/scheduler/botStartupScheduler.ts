import { loadStartupSchedulerConfig } from './config/startupSchedulerConfig.js';
import { loadEnv } from '../config/env.js';
import { refreshQueue, loadQueue } from './txScheduler.js';
import { type TtlManagerParams } from '../predict/forecastTTLManager.js';
import { runDryExecutor } from '../execute/executor.js';
import { YellowstoneAccountListener } from '../monitoring/yellowstoneAccountListener.js';
import { YellowstonePriceListener } from '../monitoring/yellowstonePriceListener.js';
import { RealtimeForecastUpdater } from '../monitoring/realtimeForecastUpdater.js';
import { PublicKey } from '@solana/web3.js';
import { getConnection } from '../solana/connection.js';
import { loadReserves, type ReserveCache } from '../cache/reserveCache.js';
import { loadOracles, type OracleCache } from '../cache/oracleCache.js';
import { logger } from '../observability/logger.js';

// Singleton guard to prevent double initialization
let isInitialized = false;
let realtimeUpdaterInstance: RealtimeForecastUpdater | null = null;
let initPromise: Promise<RealtimeForecastUpdater> | null = null;

// Store listener instances for dynamic watchlist reload
let accountListenerInstance: YellowstoneAccountListener | null = null;
let priceListenerInstance: YellowstonePriceListener | null = null;

// Cycle mutex to prevent overlapping executions
let cycleInProgress = false;
let tickDebounceTimer: NodeJS.Timeout | null = null;
let eventListenersWired = false; // Guard to prevent duplicate listener registration

function getEnvNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

function deriveObligationPubkeysFromQueue(): string[] {
  const q = loadQueue();
  return q.map(p => String(p.key)).filter(Boolean);
}

async function deriveOraclePubkeysFromReserves(env: any): Promise<{ oraclePubkeys: string[]; reserveCache: ReserveCache; oracleCache: OracleCache }> {
  const conn = getConnection();
  const market = new PublicKey(env.KAMINO_MARKET_PUBKEY);
  const reserves = await loadReserves(conn, market);
  const oracleCache = await loadOracles(conn, reserves);
  const set = new Set<string>();
  for (const [, r] of reserves.byMint.entries()) {
    for (const pk of r.oraclePubkeys) {
      set.add(pk.toString());
    }
  }
  return { oraclePubkeys: Array.from(set), reserveCache: reserves, oracleCache };
}

// Initialize listeners and orchestrator for event-driven refresh
async function initRealtime(): Promise<RealtimeForecastUpdater> {
  // Check if already initialized
  if (isInitialized && realtimeUpdaterInstance) {
    logger.info('Real-time listeners already initialized (singleton guard), reusing existing instance');
    return realtimeUpdaterInstance;
  }
  
  // Check if initialization is in progress
  if (initPromise) {
    logger.info('Real-time initialization already in progress, awaiting existing promise');
    return await initPromise;
  }
  
  // Start new initialization
  initPromise = (async () => {
    const env = loadEnv();
    const grpcUrl = env.YELLOWSTONE_GRPC_URL;
    const token = env.YELLOWSTONE_X_TOKEN;
    if (!grpcUrl) {
      throw new Error('YELLOWSTONE_GRPC_URL is missing');
    }

    const obligationPubkeys = deriveObligationPubkeysFromQueue();
    logger.info({ count: obligationPubkeys.length }, 'Derived obligation pubkeys from queue');

    const { oraclePubkeys, reserveCache, oracleCache } = await deriveOraclePubkeysFromReserves(env);
    logger.info({ count: oraclePubkeys.length }, 'Derived oracle pubkeys from reserves');

    const conn = getConnection();
    const updater = new RealtimeForecastUpdater({
      connection: conn,
      marketPubkey: new PublicKey(env.KAMINO_MARKET_PUBKEY),
      programId: new PublicKey(env.KAMINO_KLEND_PROGRAM_ID),
      reserveCache,
      oracleCache,
    });
    updater.refreshMappingFromQueue(loadQueue());
    await updater.bootstrapQueueObligations(obligationPubkeys);

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
    accountListener.on('account-update', ev => updater.handleObligationAccountUpdate(ev));
    accountListener.on('error', err => logger.error({ err }, 'Account listener error'));

    priceListener.on('ready', info => logger.info(info, 'Price listener ready'));
    priceListener.on('price-update', ev => updater.handleOracleAccountUpdate(ev));
    priceListener.on('error', err => logger.error({ err }, 'Price listener error'));

    await accountListener.start();
    await priceListener.start();

    logger.info('Real-time listeners initialized and started');

    // Set singleton guards
    isInitialized = true;
    realtimeUpdaterInstance = updater;
    
    // Store listener instances for dynamic reload
    accountListenerInstance = accountListener;
    priceListenerInstance = priceListener;

    return updater;
  })();
  
  try {
    return await initPromise;
  } finally {
    // Clear the promise so future calls after completion use the cached instance
    initPromise = null;
  }
}

/**
 * Public API to reload watchlist from queue
 * Called after candidates/queue are rebuilt to update subscriptions
 */
export async function reloadWatchlistFromQueue(): Promise<void> {
  const obligationPubkeys = deriveObligationPubkeysFromQueue();
  logger.info({ count: obligationPubkeys.length }, 'Reloading obligation watchlist from queue');

  if (accountListenerInstance) {
    accountListenerInstance.updateTargets(obligationPubkeys);
    logger.info({ count: obligationPubkeys.length }, 'Account subscriptions reloaded');
  }
  
  if (realtimeUpdaterInstance) {
    const queue = loadQueue();
    realtimeUpdaterInstance.refreshMappingFromQueue(queue);
    await realtimeUpdaterInstance.bootstrapQueueObligations(obligationPubkeys);
  }
}

export async function startBotStartupScheduler(): Promise<void> {
  // Ensure env is loaded so scheduler flags are present
  loadEnv();
  loadStartupSchedulerConfig(); // load flags/env; no local assignment needed

  // Load and display configurable thresholds
  const ttlGraceMs = getEnvNum('TTL_GRACE_MS', 60_000);
  const ttlUnknownPasses = (process.env.TTL_UNKNOWN_PASSES ?? 'true') === 'true';
  const schedMinEv = getEnvNum('SCHED_MIN_EV', 0);
  const schedMaxTtlMin = getEnvNum('SCHED_MAX_TTL_MIN', 999999);
  const schedMinHazard = getEnvNum('SCHED_MIN_HAZARD', 0);
  const schedForceIncludeLiquidatable = (process.env.SCHED_FORCE_INCLUDE_LIQUIDATABLE ?? 'true') === 'true';
  
  console.log('\n[Scheduler] Configurable Thresholds:');
  console.log(`  TTL_GRACE_MS: ${ttlGraceMs}`);
  console.log(`  TTL_UNKNOWN_PASSES: ${ttlUnknownPasses}`);
  console.log(`  SCHED_MIN_EV: ${schedMinEv}`);
  console.log(`  SCHED_MAX_TTL_MIN: ${schedMaxTtlMin}`);
  console.log(`  SCHED_MIN_HAZARD: ${schedMinHazard}`);
  console.log(`  SCHED_FORCE_INCLUDE_LIQUIDATABLE: ${schedForceIncludeLiquidatable}\n`);

  const ttlParams: TtlManagerParams = {
    forecastMaxAgeMs: getEnvNum('FORECAST_MAX_AGE_MS', 300_000),
    minRefreshIntervalMs: getEnvNum('SCHED_MIN_REFRESH_INTERVAL_MS', 60_000),
    ttlGraceMs,
    ttlUnknownPasses,
    evDropPct: getEnvNum('SCHED_EV_DROP_PCT', 0.15),
    minEv: schedMinEv,
  };

  // Initialize event-driven refresh (listeners + orchestrator)
  const enableRealtime = (process.env.ENABLE_REALTIME_REFRESH ?? 'true') === 'true';
  if (enableRealtime) {
    try {
      await initRealtime();
    } catch (err) {
      logger.warn({ err }, 'Realtime init failed; continuing without Yellowstone listeners');
    }
  } else {
    logger.info('Realtime refresh disabled via ENABLE_REALTIME_REFRESH=false');
  }
  
  async function runCycleGuarded(): Promise<void> {
    if (cycleInProgress) {
      logger.warn('Tick skipped: previous cycle still in progress');
      return;
    }
    cycleInProgress = true;
    try {
      await cycleOnce();
    } finally {
      cycleInProgress = false;
    }
  }

  // Debounced tick scheduler - ensures only one cycle runs at a time
  function scheduleTick(debounceMs = 200) {
    if (tickDebounceTimer) return; // Already scheduled
    tickDebounceTimer = setTimeout(async () => {
      tickDebounceTimer = null;
      await runCycleGuarded();
    }, debounceMs);
  }
  
  // Wire event-driven ticks on account and price updates (only once)
  if (!eventListenersWired) {
    if (accountListenerInstance) {
      accountListenerInstance.on('account-update', () => {
        scheduleTick();
      });
    }
    
    if (priceListenerInstance) {
      priceListenerInstance.on('price-update', () => {
        scheduleTick();
      });
    }
    
    eventListenersWired = true;
  }

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
      const nowMs = Date.now();
      const ttlGraceMs = getEnvNum('TTL_GRACE_MS', 60_000);
      
      // Count active vs expired using new TTL logic
      let active = 0;
      let expired = 0;
      const expiredReasons = {
        ttl_grace_exceeded: 0,
        ttl_negative: 0,
        ttl_unknown: 0,
      };
      
      for (const p of queue) {
        const ttlMin = p.ttlMin;
        const predictedAtMs = p.predictedLiquidationAtMs;
        
        let isExpired = false;
        
        if (ttlMin === null || ttlMin === undefined) {
          // Unknown TTL - check TTL_UNKNOWN_PASSES setting
          const ttlUnknownPasses = (process.env.TTL_UNKNOWN_PASSES ?? 'true') === 'true';
          if (!ttlUnknownPasses) {
            isExpired = true;
            expiredReasons.ttl_unknown++;
          }
        } else if (ttlMin < 0) {
          // Negative TTL
          isExpired = true;
          expiredReasons.ttl_negative++;
        } else if (predictedAtMs != null && nowMs > predictedAtMs + ttlGraceMs) {
          // Past predicted time + grace
          isExpired = true;
          expiredReasons.ttl_grace_exceeded++;
        }
        
        if (isExpired) {
          expired++;
        } else {
          active++;
        }
      }
      
      console.log(`[Audit] Total: ${total} | Active: ${active} | Expired: ${expired}`);
      if (expired > 0) {
        console.log(`[Audit] Expired reasons:`, expiredReasons);
      }
      
      if (total > 0) {
        const top = [...queue]
          .filter(p => {
            // Only show active plans
            const ttlMin = p.ttlMin;
            const predictedAtMs = p.predictedLiquidationAtMs;
            if (ttlMin === null || ttlMin === undefined) {
              return (process.env.TTL_UNKNOWN_PASSES ?? 'true') === 'true';
            }
            if (ttlMin < 0) return false;
            if (predictedAtMs != null && nowMs > predictedAtMs + ttlGraceMs) return false;
            return true;
          })
          .sort((a, b) =>
            (Number(b.ev) - Number(a.ev)) ||
            (Number(a.ttlMin ?? Infinity) - Number(b.ttlMin ?? Infinity)) ||
            (Number(b.hazard) - Number(a.hazard))
          )
          .slice(0, 5)
          .map(p => {
            const predictedAt = p.predictedLiquidationAtMs 
              ? new Date(p.predictedLiquidationAtMs).toISOString().slice(11, 19) // HH:MM:SS
              : 'unknown';
            return { 
              key: p.key.slice(0, 8), 
              ev: Number(p.ev ?? 0).toFixed(2), 
              ttlMin: p.ttlMin !== null && p.ttlMin !== undefined ? Number(p.ttlMin).toFixed(2) : 'null',
              predictedAt,
              hazard: Number(p.hazard ?? 0).toFixed(3) 
            };
          });
        console.table(top);
      }
    }

    // Determine mode from environment
    const broadcast = (process.env.LIQSOL_BROADCAST === 'true') || (process.env.EXECUTOR_BROADCAST === 'true');
    const dry = !broadcast;
    
    // SCHEDULER_ENABLE_EXECUTOR controls whether executor runs at all (in both dry-run and broadcast modes)
    // Legacy name SCHEDULER_ENABLE_DRYRUN is kept for backward compatibility but now enables both modes
    const enableExecutorFlag = process.env.SCHEDULER_ENABLE_EXECUTOR ?? process.env.SCHEDULER_ENABLE_DRYRUN ?? 'true';
    const executorEnabled = enableExecutorFlag === 'true';
    
    if (executorEnabled) {
      // Log invocation with explicit mode flags
      console.log(`[Scheduler] Invoking executor (dry=${dry}, broadcast=${broadcast})`);
      
      try {
        const res = await runDryExecutor({ dry, broadcast });
        console.log('[Executor] Completed:', res?.status ?? 'ok');
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.warn('[Executor] Failed:', err.message);
        // Always print full stack trace for failures
        if (err.stack) {
          console.warn('[Executor] Stack trace:');
          console.warn(err.stack);
        }
        // Re-throw the typed Error object to preserve stack and type information
        throw err;
      }
    } else {
      console.log('[Scheduler] Executor disabled (SCHEDULER_ENABLE_EXECUTOR=false)');
    }

    console.log('[Scheduler] Cycle end');
  }

  // Run initial cycle; rely on event-driven triggers afterwards
  await runCycleGuarded();

  // Keep a very slow heartbeat cycle for audit/logging (optional)
  const heartbeatMs = Number(process.env.SCHED_HEARTBEAT_INTERVAL_MS ?? 60000);
  setInterval(() => {
    // Use scheduleTick to avoid overlapping cycles
    scheduleTick();
  }, heartbeatMs);
}
