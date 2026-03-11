import { loadEnv } from '../config/env.js';

export interface LiveRuntimeEnvConfig {
  rebuildIntervalMs: number;
  heartbeatIntervalMs: number;
  tickDebounceMs: number;
  queueEmptyLogIntervalMs: number;
  promotionSummaryLogIntervalMs: number;
  realtimeEnabled: boolean;
  yellowstoneReconnectBaseMs: number;
  yellowstoneReconnectMaxMs: number;
  yellowstoneResubscribeSettleMs: number;
}

function parseMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function loadLiveRuntimeConfig(): LiveRuntimeEnvConfig {
  const env = loadEnv();
  return {
    rebuildIntervalMs: parseMs(
      process.env.LIVE_REBUILD_INTERVAL_MS ?? process.env.LIVE_CANDIDATE_REFRESH_INTERVAL_MS ?? env.LIVE_REBUILD_INTERVAL_MS,
      120_000,
    ),
    heartbeatIntervalMs: parseMs(
      process.env.LIVE_HEARTBEAT_INTERVAL_MS ?? process.env.SCHED_HEARTBEAT_INTERVAL_MS ?? env.LIVE_HEARTBEAT_INTERVAL_MS,
      60_000,
    ),
    tickDebounceMs: parseMs(process.env.LIVE_TICK_DEBOUNCE_MS ?? env.LIVE_TICK_DEBOUNCE_MS, 200),
    queueEmptyLogIntervalMs: parseMs(
      process.env.LIVE_QUEUE_EMPTY_LOG_INTERVAL_MS ?? env.LIVE_QUEUE_EMPTY_LOG_INTERVAL_MS,
      30_000,
    ),
    promotionSummaryLogIntervalMs: parseMs(
      process.env.LIVE_PROMOTION_SUMMARY_LOG_INTERVAL_MS ?? env.LIVE_PROMOTION_SUMMARY_LOG_INTERVAL_MS,
      10_000,
    ),
    realtimeEnabled:
      (process.env.LIVE_REALTIME_ENABLED ?? process.env.ENABLE_REALTIME_REFRESH ?? env.LIVE_REALTIME_ENABLED) === 'true',
    yellowstoneReconnectBaseMs: parseMs(
      process.env.YELLOWSTONE_RECONNECT_BASE_MS ?? env.YELLOWSTONE_RECONNECT_BASE_MS,
      1_000,
    ),
    yellowstoneReconnectMaxMs: parseMs(
      process.env.YELLOWSTONE_RECONNECT_MAX_MS ?? env.YELLOWSTONE_RECONNECT_MAX_MS,
      30_000,
    ),
    yellowstoneResubscribeSettleMs: parseMs(
      process.env.YELLOWSTONE_RESUBSCRIBE_SETTLE_MS ?? env.YELLOWSTONE_RESUBSCRIBE_SETTLE_MS,
      250,
    ),
  };
}
