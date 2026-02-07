import fs from 'node:fs';
import path from 'node:path';
import { refreshQueue } from '../src/scheduler/txScheduler.js';
import { type TtlManagerParams } from '../src/predict/forecastTTLManager.js';

function getEnvNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

(async () => {
  const params: TtlManagerParams = {
    forecastMaxAgeMs: getEnvNum('FORECAST_MAX_AGE_MS', 300_000),
    minRefreshIntervalMs: getEnvNum('SCHED_MIN_REFRESH_INTERVAL_MS', 60_000),
    ttlExpiredMarginMin: getEnvNum('SCHED_TTL_EXPIRED_MARGIN_MIN', 2),
    evDropPct: getEnvNum('SCHED_EV_DROP_PCT', 0.15),
    minEv: getEnvNum('SCHED_MIN_EV', 0),
  };

  // Optionally load candidates as source to improve recomputation accuracy
  const candidatesPath = path.join(process.cwd(), 'data', 'candidates.json');
  const candidateSource = fs.existsSync(candidatesPath) ? JSON.parse(fs.readFileSync(candidatesPath, 'utf8')) : [];
  const normalized = Array.isArray(candidateSource) ? candidateSource : (Array.isArray(candidateSource.candidates) ? candidateSource.candidates : Object.values(candidateSource));

  const before = fs.existsSync(path.join(process.cwd(), 'data', 'tx_queue.json')) ? JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'tx_queue.json'), 'utf8')) : [];
  console.log(`Before refresh: ${before.length} plan(s)`);

  const after = refreshQueue(params, normalized);
  console.log(`After refresh: ${after.length} plan(s)`);
  console.table(after.slice(0, 10).map(p => ({ key: p.key, ev: Number(p.ev).toFixed(2), hazard: Number(p.hazard).toFixed(3), ttlMin: Number(p.ttlMin).toFixed(2), updatedAt: p.createdAtMs })));
})();
