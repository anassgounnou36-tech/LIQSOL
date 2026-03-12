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

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  return value === 'true';
}

export function loadLiveRuntimeConfig(): LiveRuntimeEnvConfig {
  const env = loadEnv();
  return {
    rebuildIntervalMs: parseMs(
      env.LIVE_REBUILD_INTERVAL_MS ?? env.LIVE_CANDIDATE_REFRESH_INTERVAL_MS,
      120_000,
    ),
    heartbeatIntervalMs: parseMs(
      env.LIVE_HEARTBEAT_INTERVAL_MS ?? env.SCHED_HEARTBEAT_INTERVAL_MS,
      60_000,
    ),
    tickDebounceMs: parseMs(env.LIVE_TICK_DEBOUNCE_MS, 200),
    queueEmptyLogIntervalMs: parseMs(
      env.LIVE_QUEUE_EMPTY_LOG_INTERVAL_MS,
      30_000,
    ),
    promotionSummaryLogIntervalMs: parseMs(
      env.LIVE_PROMOTION_SUMMARY_LOG_INTERVAL_MS,
      10_000,
    ),
    realtimeEnabled: parseBool(env.LIVE_REALTIME_ENABLED, parseBool(env.ENABLE_REALTIME_REFRESH, true)),
    yellowstoneReconnectBaseMs: parseMs(
      env.YELLOWSTONE_RECONNECT_BASE_MS,
      1_000,
    ),
    yellowstoneReconnectMaxMs: parseMs(
      env.YELLOWSTONE_RECONNECT_MAX_MS,
      30_000,
    ),
    yellowstoneResubscribeSettleMs: parseMs(
      env.YELLOWSTONE_RESUBSCRIBE_SETTLE_MS,
      250,
    ),
  };
}
