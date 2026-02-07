import fs from 'node:fs';
import path from 'node:path';
import { filterCandidates, normalizeCandidates } from '../src/scheduler/txFilters.js';
import { buildPlanFromCandidate } from '../src/scheduler/txBuilder.js';
import { enqueuePlans } from '../src/scheduler/txScheduler.js';
import { type EvParams } from '../src/predict/evCalculator.js';

function loadCandidatesPayload(): any {
  const p = path.join(process.cwd(), 'data', 'candidates.json');
  if (!fs.existsSync(p)) throw new Error('Missing data/candidates.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function getEnvNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

function getOptionalEnvNum(key: string): number | undefined {
  const v = process.env[key];
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

(async () => {
  const hazardAlpha = getEnvNum('HAZARD_ALPHA', 25);
  const evParams: EvParams = {
    closeFactor: getEnvNum('EV_CLOSE_FACTOR', 0.5),
    liquidationBonusPct: getEnvNum('EV_LIQUIDATION_BONUS_PCT', 0.05),
    flashloanFeePct: getEnvNum('EV_FLASHLOAN_FEE_PCT', 0.002),
    fixedGasUsd: getEnvNum('EV_FIXED_GAS_USD', 0.5),
    slippageBufferPct: getOptionalEnvNum('EV_SLIPPAGE_BUFFER_PCT'),
  };
  const params = {
    minEv: getEnvNum('SCHED_MIN_EV', 0),
    maxTtlMin: getEnvNum('SCHED_MAX_TTL_MIN', 10),
    minHazard: getEnvNum('SCHED_MIN_HAZARD', 0.05),
    hazardAlpha,
    evParams,
    ttlDropPerMinPct: getEnvNum('TTL_SOL_DROP_PCT_PER_MIN', 0.2),
    ttlMaxDropPct: getEnvNum('TTL_MAX_DROP_PCT', 20),
  };

  const payload = loadCandidatesPayload();
  const candidates = normalizeCandidates(payload);
  const filtered = filterCandidates(candidates, params);

  console.log('\n📋 Filtered candidates (up to 10):');
  console.table(filtered.slice(0, 10).map((c) => ({
    key: c.key,
    hr: Number(c.healthRatio).toFixed(4),
    ev: Number(c.ev).toFixed(2),
    hazard: Number(c.hazard).toFixed(3),
    ttl: c.ttlStr,
    borrowUsd: Number(c.borrowUsd).toFixed(2),
  })));

  const plans = filtered.map((c) => buildPlanFromCandidate(c, 'USDC'));
  const queued = enqueuePlans(plans);
  console.log(`\n✅ Scheduled ${plans.length} plan(s). Queue size: ${queued.length}`);
})();
