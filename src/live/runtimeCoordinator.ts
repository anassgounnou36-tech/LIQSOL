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
  private readonly runtimeEnvConfig = loadLiveRuntimeConfig();
  private accountListener: YellowstoneAccountListener | null = null;
  private priceListener: YellowstonePriceListener | null = null;
  private updater: RealtimeForecastUpdater | null = null;
  private startupSchedulerConfig = loadStartupSchedulerConfig();
  private started = false;
  private stopping = false;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private cycleInProgress = false;
  private tickDebounceTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private rebuildInProgress = false;
  private broadcast = false;
  private lastRebuildAtMs: number | null = null;

  constructor(
    private readonly deps: RuntimeCoordinatorDeps,
    private readonly config: RuntimeCoordinatorConfig,
  ) {}

  async start(opts: { broadcast: boolean }): Promise<void> {
    if (this.started) {
      if (this.startPromise) return this.startPromise;
      return;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal(opts).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startInternal(opts: { broadcast: boolean }): Promise<void> {
    this.broadcast = opts.broadcast;
    this.stopping = false;
    this.started = true;
    loadEnv();
    this.startupSchedulerConfig = loadStartupSchedulerConfig();

    if (this.config.realtimeEnabled) {
      try {
        await this.initRealtime();
      } catch (err) {
        logger.warn({ err }, 'Realtime init failed; continuing without Yellowstone listeners');
      }
    } else {
      logger.info('Realtime refresh disabled via LIVE_REALTIME_ENABLED=false');
    }

    await this.runCycle('startup');

    this.heartbeatTimer = setInterval(() => {
      this.emitHeartbeatSummary('heartbeat');
      this.scheduleCycle('heartbeat');
    }, this.config.heartbeatIntervalMs);
    this.rebuildTimer = setInterval(() => {
      void this.runPeriodicRebuild('periodic-rebuild');
    }, this.config.rebuildIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.started && !this.stopping) return;
    this.stopPromise = this.stopInternal().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    this.stopping = true;
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
    this.updater = null;
    for (const listener of listeners) {
      if (listener) await listener.stop();
    }
    this.stopping = false;
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
      this.lastRebuildAtMs = Date.now();
      await this.reloadWatchTargets(reason);
      logger.info({ reason }, 'Runtime rebuild complete');
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

  private scheduleCycle(reason: string, debounceMs = this.config.tickDebounceMs): void {
    if (!this.started || this.stopping || this.tickDebounceTimer) return;
    this.tickDebounceTimer = setTimeout(async () => {
      this.tickDebounceTimer = null;
      await this.runCycle(reason);
    }, debounceMs);
  }

  private async runCycle(reason: string): Promise<void> {
    if (!this.started || this.stopping) return;
    if (this.cycleInProgress) {
      logger.debug({ reason }, 'Runtime cycle skipped: previous cycle still in progress');
      return;
    }
    this.cycleInProgress = true;
    try {
      await this.cycleOnce(reason);
    } finally {
      this.cycleInProgress = false;
    }
  }

  private async initRealtime(): Promise<void> {
    if (this.updater && this.accountListener && this.priceListener) return;
    const env = loadEnv();
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
      reconnectBaseMs: this.runtimeEnvConfig.yellowstoneReconnectBaseMs,
      reconnectMaxMs: this.runtimeEnvConfig.yellowstoneReconnectMaxMs,
      resubscribeSettleMs: this.runtimeEnvConfig.yellowstoneResubscribeSettleMs,
      debounceMs: this.config.tickDebounceMs,
    });
    const priceListener = new YellowstonePriceListener({
      grpcUrl,
      authToken: env.YELLOWSTONE_X_TOKEN,
      oraclePubkeys,
      reconnectBaseMs: this.runtimeEnvConfig.yellowstoneReconnectBaseMs,
      reconnectMaxMs: this.runtimeEnvConfig.yellowstoneReconnectMaxMs,
      resubscribeSettleMs: this.runtimeEnvConfig.yellowstoneResubscribeSettleMs,
      debounceMs: this.config.tickDebounceMs,
    });

    accountListener.on('ready', info => logger.info(info, 'Account listener ready'));
    accountListener.on('account-update', ev => {
      this.updater?.handleObligationAccountUpdate(ev);
      this.scheduleCycle('account-update');
    });
    accountListener.on('error', err => logger.error({ err }, 'Account listener error'));

    priceListener.on('ready', info => logger.info(info, 'Price listener ready'));
    priceListener.on('price-update', ev => {
      this.updater?.handleOracleAccountUpdate(ev);
      this.scheduleCycle('price-update');
    });
    priceListener.on('error', err => logger.error({ err }, 'Price listener error'));

    await accountListener.start();
    await priceListener.start();

    this.accountListener = accountListener;
    this.priceListener = priceListener;
    this.updater = updater;
  }

  private async cycleOnce(reason: string): Promise<void> {
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

    if (this.startupSchedulerConfig.enableRefresh) {
      const updated = refreshQueue(ttlParams, []);
      logger.debug({ reason, queueSize: updated.length }, 'Runtime refresh queue pass complete');
    }

    if (this.startupSchedulerConfig.enableAudit) {
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
      logger.debug({ reason, total, active, expired, expiredReasons }, 'Runtime queue audit summary');
    }

    const dry = !this.broadcast;
    if (this.startupSchedulerConfig.enableExecutor) {
      try {
        await runDryExecutor({
          dry,
          broadcast: this.broadcast,
          queueEmptyLogIntervalMs: this.config.queueEmptyLogIntervalMs,
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn({ err, reason }, 'Runtime executor pass failed');
      }
    }
  }

  private emitHeartbeatSummary(reason: string): void {
    const snapshot = this.watchStateStore.getCurrent();
    const queueSize = loadQueue().length;
    logger.info(
      {
        reason,
        queueSize,
        queueTargets: snapshot.queueTargets.length,
        shadowOnlyTargets: snapshot.shadowOnlyTargets.length,
        allWatchTargets: snapshot.allWatchTargets.length,
        cycleInProgress: this.cycleInProgress,
        lastRebuildAtMs: this.lastRebuildAtMs,
        lastRebuildAgeMs: this.lastRebuildAtMs === null ? null : Date.now() - this.lastRebuildAtMs,
        realtimeEnabled: this.config.realtimeEnabled,
      },
      'Runtime heartbeat summary',
    );
  }
}
