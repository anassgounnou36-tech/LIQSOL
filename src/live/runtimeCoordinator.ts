import { PublicKey } from '@solana/web3.js';
import { loadEnv } from '../config/env.js';
import { logger } from '../observability/logger.js';
import { runInitialPipeline } from '../pipeline/runInitialPipeline.js';
import { loadStartupSchedulerConfig } from '../scheduler/config/startupSchedulerConfig.js';
import { type TtlManagerParams } from '../predict/forecastTTLManager.js';
import { refreshQueue, loadQueue } from '../scheduler/txScheduler.js';
import { runDryExecutor } from '../execute/executor.js';
import { YellowstoneAccountListener } from '../monitoring/yellowstoneAccountListener.js';
import { YellowstonePriceListener } from '../monitoring/yellowstonePriceListener.js';
import { RealtimeForecastUpdater } from '../monitoring/realtimeForecastUpdater.js';
import { getConnection } from '../solana/connection.js';
import { loadReserves, type ReserveCache } from '../cache/reserveCache.js';
import { loadOracles, type OracleCache } from '../cache/oracleCache.js';
import { WatchStateStore } from './watchStateStore.js';
import { loadLiveRuntimeConfig } from './runtimeConfig.js';

export interface RuntimeCoordinatorDeps {
  marketPubkey: PublicKey;
  programId: PublicKey;
  execAllowlistMints?: string[];
}

export interface RuntimeCoordinatorConfig {
  rebuildIntervalMs: number;
  heartbeatIntervalMs: number;
  tickDebounceMs: number;
  queueEmptyLogIntervalMs: number;
  promotionSummaryLogIntervalMs: number;
  realtimeEnabled: boolean;
}

function getEnvNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

function fingerprintsChanged(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return true;
  for (const item of a) {
    if (!b.has(item)) return true;
  }
  return false;
}

async function deriveOraclePubkeysFromReserves(marketPubkey: PublicKey): Promise<{
  oraclePubkeys: string[];
  reserveCache: ReserveCache;
  oracleCache: OracleCache;
}> {
  const conn = getConnection();
  const reserves = await loadReserves(conn, marketPubkey);
  const oracleCache = await loadOracles(conn, reserves);
  const set = new Set<string>();
  for (const [, reserve] of reserves.byMint.entries()) {
    for (const pk of reserve.oraclePubkeys) set.add(pk.toString());
  }
  return { oraclePubkeys: Array.from(set), reserveCache: reserves, oracleCache };
}

export class RuntimeCoordinator {
  private readonly watchStateStore = new WatchStateStore();
  private accountListener: YellowstoneAccountListener | null = null;
  private priceListener: YellowstonePriceListener | null = null;
  private updater: RealtimeForecastUpdater | null = null;
  private started = false;
  private startPromise: Promise<void> | null = null;
  private cycleInProgress = false;
  private tickDebounceTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private rebuildInProgress = false;
  private broadcast = false;

  constructor(
    private readonly deps: RuntimeCoordinatorDeps,
    private readonly config: RuntimeCoordinatorConfig,
  ) {}

  async start(opts: { broadcast: boolean }): Promise<void> {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal(opts).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(opts: { broadcast: boolean }): Promise<void> {
    this.broadcast = opts.broadcast;
    this.started = true;
    loadEnv();
    loadStartupSchedulerConfig();

    if (this.config.realtimeEnabled) {
      try {
        await this.initRealtime();
      } catch (err) {
        logger.warn({ err }, 'Realtime init failed; continuing without Yellowstone listeners');
      }
    } else {
      logger.info('Realtime refresh disabled via LIVE_REALTIME_ENABLED=false');
    }

    await this.runCycleGuarded();

    this.heartbeatTimer = setInterval(() => {
      this.scheduleTick();
    }, this.config.heartbeatIntervalMs);
    this.rebuildTimer = setInterval(() => {
      void this.runPeriodicRebuild('periodic-rebuild');
    }, this.config.rebuildIntervalMs);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.tickDebounceTimer) {
      clearTimeout(this.tickDebounceTimer);
      this.tickDebounceTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.rebuildTimer) {
      clearInterval(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    const listeners = [this.accountListener, this.priceListener];
    this.accountListener = null;
    this.priceListener = null;
    for (const listener of listeners) {
      if (listener) await listener.stop();
    }
    this.updater = null;
  }

  async runPeriodicRebuild(reason: string): Promise<void> {
    if (this.rebuildInProgress) {
      logger.info({ reason }, 'Skipping rebuild: previous rebuild still running');
      return;
    }
    this.rebuildInProgress = true;
    try {
      const env = loadEnv();
      await runInitialPipeline({
        marketPubkey: this.deps.marketPubkey,
        programId: this.deps.programId,
        execAllowlistMints: this.deps.execAllowlistMints,
        topN: Number(env.CAND_TOP ?? 50),
        nearThreshold: Number(env.CAND_NEAR ?? 1.02),
        flashloanMint: 'USDC',
      });
      await this.reloadWatchTargets(reason);
    } finally {
      this.rebuildInProgress = false;
    }
  }

  async reloadWatchTargets(reason: string): Promise<void> {
    const nextSnapshot = this.watchStateStore.loadFromFiles();
    const prevSnapshot = this.watchStateStore.getCurrent();
    const changed = fingerprintsChanged(prevSnapshot.fingerprints, nextSnapshot.fingerprints);
    logger.info(
      {
        reason,
        queueTargets: nextSnapshot.queueTargets.length,
        shadowOnlyTargets: nextSnapshot.shadowOnlyTargets.length,
        allWatchTargets: nextSnapshot.allWatchTargets.length,
        changed,
      },
      'Runtime watch-target reload',
    );
    if (!changed) return;
    this.watchStateStore.replace(nextSnapshot);
    const obligationPubkeys = nextSnapshot.allWatchTargets.map(target => target.obligationPubkey);
    if (this.accountListener) {
      this.accountListener.updateTargets(obligationPubkeys);
    }
    if (this.updater) {
      await this.updater.refreshMappingFromWatchTargets(nextSnapshot.allWatchTargets);
      await this.updater.bootstrapWatchObligations(obligationPubkeys);
    }
  }

  private scheduleTick(debounceMs = this.config.tickDebounceMs): void {
    if (!this.started || this.tickDebounceTimer) return;
    this.tickDebounceTimer = setTimeout(async () => {
      this.tickDebounceTimer = null;
      await this.runCycleGuarded();
    }, debounceMs);
  }

  private async runCycleGuarded(): Promise<void> {
    if (this.cycleInProgress) {
      logger.warn('Tick skipped: previous cycle still in progress');
      return;
    }
    this.cycleInProgress = true;
    try {
      await this.cycleOnce();
    } finally {
      this.cycleInProgress = false;
    }
  }

  private async initRealtime(): Promise<void> {
    if (this.updater && this.accountListener && this.priceListener) return;
    const env = loadEnv();
    const runtimeEnvConfig = loadLiveRuntimeConfig();
    const grpcUrl = env.YELLOWSTONE_GRPC_URL;
    if (!grpcUrl) {
      throw new Error('YELLOWSTONE_GRPC_URL is missing');
    }

    const currentSnapshot = this.watchStateStore.loadFromFiles();
    this.watchStateStore.replace(currentSnapshot);
    const obligationPubkeys = currentSnapshot.allWatchTargets.map(target => target.obligationPubkey);
    const { oraclePubkeys, reserveCache, oracleCache } = await deriveOraclePubkeysFromReserves(this.deps.marketPubkey);
    const updater = new RealtimeForecastUpdater({
      connection: getConnection(),
      marketPubkey: this.deps.marketPubkey,
      programId: this.deps.programId,
      reserveCache,
      oracleCache,
      promotionSummaryLogIntervalMs: this.config.promotionSummaryLogIntervalMs,
    });
    await updater.refreshMappingFromWatchTargets(currentSnapshot.allWatchTargets);
    await updater.bootstrapWatchObligations(obligationPubkeys);

    const accountListener = new YellowstoneAccountListener({
      grpcUrl,
      authToken: env.YELLOWSTONE_X_TOKEN,
      accountPubkeys: obligationPubkeys,
      reconnectBaseMs: runtimeEnvConfig.yellowstoneReconnectBaseMs,
      reconnectMaxMs: runtimeEnvConfig.yellowstoneReconnectMaxMs,
      resubscribeSettleMs: runtimeEnvConfig.yellowstoneResubscribeSettleMs,
      debounceMs: this.config.tickDebounceMs,
    });
    const priceListener = new YellowstonePriceListener({
      grpcUrl,
      authToken: env.YELLOWSTONE_X_TOKEN,
      oraclePubkeys,
      reconnectBaseMs: runtimeEnvConfig.yellowstoneReconnectBaseMs,
      reconnectMaxMs: runtimeEnvConfig.yellowstoneReconnectMaxMs,
      resubscribeSettleMs: runtimeEnvConfig.yellowstoneResubscribeSettleMs,
      debounceMs: this.config.tickDebounceMs,
    });

    accountListener.on('ready', info => logger.info(info, 'Account listener ready'));
    accountListener.on('account-update', ev => {
      updater.handleObligationAccountUpdate(ev);
      this.scheduleTick();
    });
    accountListener.on('error', err => logger.error({ err }, 'Account listener error'));

    priceListener.on('ready', info => logger.info(info, 'Price listener ready'));
    priceListener.on('price-update', ev => {
      updater.handleOracleAccountUpdate(ev);
      this.scheduleTick();
    });
    priceListener.on('error', err => logger.error({ err }, 'Price listener error'));

    await accountListener.start();
    await priceListener.start();

    this.updater = updater;
    this.accountListener = accountListener;
    this.priceListener = priceListener;
  }

  private async cycleOnce(): Promise<void> {
    console.log('\n[Scheduler] Cycle start');
    const ttlGraceMs = getEnvNum('TTL_GRACE_MS', 60_000);
    const ttlUnknownPasses = (process.env.TTL_UNKNOWN_PASSES ?? 'true') === 'true';
    const ttlParams: TtlManagerParams = {
      forecastMaxAgeMs: getEnvNum('FORECAST_MAX_AGE_MS', 300_000),
      minRefreshIntervalMs: getEnvNum('SCHED_MIN_REFRESH_INTERVAL_MS', 60_000),
      ttlGraceMs,
      ttlUnknownPasses,
      evDropPct: getEnvNum('SCHED_EV_DROP_PCT', 0.15),
      minEv: getEnvNum('SCHED_MIN_EV', 0),
    };

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
      let active = 0;
      let expired = 0;
      const expiredReasons = { ttl_grace_exceeded: 0, ttl_negative: 0, ttl_unknown: 0 };
      for (const plan of queue) {
        const ttlMin = plan.ttlMin;
        const predictedAtMs = plan.predictedLiquidationAtMs;
        let isExpired = false;
        if (ttlMin === null || ttlMin === undefined) {
          if ((process.env.TTL_UNKNOWN_PASSES ?? 'true') !== 'true') {
            isExpired = true;
            expiredReasons.ttl_unknown++;
          }
        } else if (ttlMin < 0) {
          isExpired = true;
          expiredReasons.ttl_negative++;
        } else if (predictedAtMs != null && nowMs > predictedAtMs + ttlGraceMs) {
          isExpired = true;
          expiredReasons.ttl_grace_exceeded++;
        }
        if (isExpired) expired++;
        else active++;
      }
      console.log(`[Audit] Total: ${total} | Active: ${active} | Expired: ${expired}`);
      if (expired > 0) console.log('[Audit] Expired reasons:', expiredReasons);
    }

    const dry = !this.broadcast;
    const enableExecutorFlag = process.env.SCHEDULER_ENABLE_EXECUTOR ?? process.env.SCHEDULER_ENABLE_DRYRUN ?? 'true';
    if (enableExecutorFlag === 'true') {
      console.log(`[Scheduler] Invoking executor (dry=${dry}, broadcast=${this.broadcast})`);
      try {
        await runDryExecutor({
          dry,
          broadcast: this.broadcast,
          queueEmptyLogIntervalMs: this.config.queueEmptyLogIntervalMs,
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.warn('[Executor] Failed:', err.message);
        if (err.stack) {
          console.warn('[Executor] Stack trace:');
          console.warn(err.stack);
        }
      }
    } else {
      console.log('[Scheduler] Executor disabled (SCHEDULER_ENABLE_EXECUTOR=false)');
    }

    console.log('[Scheduler] Cycle end');
  }
}
