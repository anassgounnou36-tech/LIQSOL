/**
 * Audit Forecasts CLI
 * - Loads forecasted entries (e.g., from data/tx_queue.json plans)
 * - Evaluates freshness and EV deltas
 * - Prints a summary of expired vs active and suggested refresh actions
 */

import fs from 'node:fs';
import path from 'node:path';
import { evaluateForecasts, getExpiredForecasts, filterActiveForecasts, parseTtlMinutes, type ForecastEntry, type TtlManagerParams } from '../predict/forecastTTLManager.js';

function loadQueue(): any[] {
  const p = path.join(process.cwd(), 'data', 'tx_queue.json');
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function getEnvNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

(() => {
  const queue = loadQueue();

  // Normalize queue entries to ForecastEntry
  const forecasts: ForecastEntry[] = queue.map((q: any) => ({
    key: q.key ?? q.obligationPubkey ?? 'unknown',
    ev: Number(q.ev ?? 0),
    hazard: Number(q.hazard ?? 0),
    ttlStr: q.ttl ?? q.ttlStr,
    ttlMin: q.ttlMin ?? parseTtlMinutes(q.ttl ?? q.ttlStr),
    forecastUpdatedAtMs: Number(q.createdAtMs ?? q.forecastUpdatedAtMs ?? 0),
  }));

  const params: TtlManagerParams = {
    forecastMaxAgeMs: getEnvNum('FORECAST_MAX_AGE_MS', 300_000),
    minRefreshIntervalMs: getEnvNum('SCHED_MIN_REFRESH_INTERVAL_MS', 60_000),
    ttlExpiredMarginMin: getEnvNum('SCHED_TTL_EXPIRED_MARGIN_MIN', 2),
    evDropPct: getEnvNum('SCHED_EV_DROP_PCT', 0.15),
    minEv: getEnvNum('SCHED_MIN_EV', 0),
  };

  // Build prev EV map from queue metadata if present
  const prevEvByKey = new Map<string, number>();
  for (const q of queue) {
    const key = q.key ?? q.obligationPubkey ?? 'unknown';
    const prev = Number(q.prevEv ?? q.ev);
    prevEvByKey.set(key, prev);
  }

  const evaluated = evaluateForecasts(forecasts, params, { prevEvByKey });
  const expired = getExpiredForecasts(evaluated);
  const active = filterActiveForecasts(evaluated);

  console.log('\n📊 Forecast Audit Summary');
  console.log('='.repeat(70));
  console.log(`Total: ${evaluated.length}`);
  console.log(`Active: ${active.length}`);
  console.log(`Expired: ${expired.length}`);

  console.log('\n[ACTIVE] Top 10:');
  console.table(active.slice(0, 10).map(x => ({
    key: x.key,
    ev: Number(x.ev).toFixed(2),
    hazard: Number(x.hazard).toFixed(3),
    ttlMin: Number(x.ttlMin).toFixed(2),
    ageMs: (Date.now() - x.forecastUpdatedAtMs),
  })));

  if (expired.length) {
    console.log('\n[EXPIRED] Up to 10:');
    console.table(expired.slice(0, 10).map(x => ({
      key: x.key,
      ev: Number(x.ev).toFixed(2),
      hazard: Number(x.hazard).toFixed(3),
      ttlMin: Number(x.ttlMin).toFixed(2),
      ageMs: (Date.now() - x.forecastUpdatedAtMs),
      reason: x.reason,
      prevEv: x.prevEv,
    })));
    console.log(`\n🔁 Suggest refresh: ${expired.length} of ${evaluated.length} forecasts are expired or need recompute`);
  } else {
    console.log('\n✓ No expired forecasts detected.');
  }
})();
