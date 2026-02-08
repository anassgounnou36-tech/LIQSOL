import fs from 'node:fs';
import path from 'node:path';
import { loadStartupSchedulerConfig } from './config/startupSchedulerConfig.js';
import { loadEnv } from '../config/env.js';
import { refreshQueue, loadQueue } from './txScheduler.js';
import { type TtlManagerParams } from '../predict/forecastTTLManager.js';
import { runDryExecutor } from '../execute/executor.js';

function getEnvNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

function loadCandidateSource(): unknown[] {
  const candidatesPath = path.join(process.cwd(), 'data', 'candidates.json');
  if (!fs.existsSync(candidatesPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.candidates)) return raw.candidates;
    return Object.values(raw);
  } catch {
    return [];
  }
}

export async function startBotStartupScheduler(): Promise<void> {
  loadEnv();
  const cfg = loadStartupSchedulerConfig();

  const ttlParams: TtlManagerParams = {
    forecastMaxAgeMs: getEnvNum('FORECAST_MAX_AGE_MS', 300_000),
    minRefreshIntervalMs: getEnvNum('SCHED_MIN_REFRESH_INTERVAL_MS', 60_000),
    ttlExpiredMarginMin: getEnvNum('SCHED_TTL_EXPIRED_MARGIN_MIN', 2),
    evDropPct: getEnvNum('SCHED_EV_DROP_PCT', 0.15),
    minEv: getEnvNum('SCHED_MIN_EV', 0),
  };

  const candidateSource = loadCandidateSource();

  async function cycleOnce(): Promise<void> {
    console.log('\n[Scheduler] Cycle start');

    if (cfg.enableRefresh) {
      const updated = refreshQueue(ttlParams, candidateSource);
      console.log(`[Scheduler] Refresh complete: queue size ${updated.length}`);
    } else {
      console.log('[Scheduler] Refresh disabled.');
    }

    if (cfg.enableAudit) {
      const queue = loadQueue();
      const total = queue.length;
      const active = queue.filter(p => Number(p.ttlMin ?? Infinity) > 0).length;
      const expired = total - active;
      console.log(`[Audit] Total: ${total} | Active: ${active} | Expired: ${expired}`);
      if (total > 0) {
        const top = [...queue]
          .sort((a, b) => (Number(b.ev) - Number(a.ev)) || (Number(a.ttlMin) - Number(b.ttlMin)) || (Number(b.hazard) - Number(a.hazard)))
          .slice(0, 5)
          .map(p => ({ key: p.key, ev: Number(p.ev).toFixed(2), ttlMin: Number(p.ttlMin).toFixed(2), hazard: Number(p.hazard).toFixed(3) }));
        console.table(top);
      }
    } else {
      console.log('[Audit] Disabled.');
    }

    if (cfg.enableDryRun) {
      try {
        const res = await runDryExecutor({ dry: true });
        console.log('[Executor] Dry-run completed:', res?.status ?? 'ok');
      } catch (e) {
        console.warn('[Executor] Dry-run failed:', (e as Error).message);
      }
    } else {
      console.log('[Executor] Dry-run disabled.');
    }

    console.log('[Scheduler] Cycle end');
  }

  await cycleOnce();
  setInterval(() => {
    cycleOnce().catch(err => console.error('[Scheduler] Cycle error:', err));
  }, cfg.loopIntervalMs);
}

(async () => {
  await startBotStartupScheduler();
})();
