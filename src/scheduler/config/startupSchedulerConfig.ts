import { loadEnv } from '../../config/env.js';

export interface StartupSchedulerConfig {
  enableRefresh: boolean;
  enableAudit: boolean;
  enableDryRun: boolean;
  loopIntervalMs: number;
  minEv: number;
  maxTtlMin: number;
  minDelayMs: number;
}

export function loadStartupSchedulerConfig(): StartupSchedulerConfig {
  const env = loadEnv();
  return {
    enableRefresh: (process.env.SCHEDULER_ENABLE_REFRESH ?? 'true') === 'true',
    enableAudit: (process.env.SCHEDULER_ENABLE_AUDIT ?? 'true') === 'true',
    enableDryRun: (process.env.SCHEDULER_ENABLE_DRYRUN ?? 'true') === 'true',
    loopIntervalMs: Number(process.env.SCHEDULER_MAIN_INTERVAL_MS ?? process.env.SCHED_REFRESH_INTERVAL_MS ?? 30000),
    minEv: Number(env.EXEC_MIN_EV ?? 0),
    maxTtlMin: Number(env.EXEC_MAX_TTL_MIN ?? 10),
    minDelayMs: Number(env.SCHEDULED_MIN_LIQUIDATION_DELAY_MS ?? 0),
  };
}
