import fs from 'node:fs';
import path from 'node:path';
import { filterCandidatesWithStats, normalizeCandidates } from '../src/scheduler/txFilters.js';
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

  // Print resolved scheduler parameters
  console.log('\n🔧 Scheduler Parameters (from .env):');
  console.log(`  SCHED_MIN_EV:          ${params.minEv}`);
  console.log(`  SCHED_MAX_TTL_MIN:     ${params.maxTtlMin}`);
  console.log(`  SCHED_MIN_HAZARD:      ${params.minHazard}`);
  console.log(`  HAZARD_ALPHA:          ${hazardAlpha}`);
  console.log(`  TTL_SOL_DROP_PCT:      ${params.ttlDropPerMinPct}`);
  console.log(`  TTL_MAX_DROP_PCT:      ${params.ttlMaxDropPct}`);
  console.log('\n🧮 EV Parameters:');
  console.log(`  Close Factor:          ${evParams.closeFactor}`);
  console.log(`  Liquidation Bonus:     ${evParams.liquidationBonusPct * 100}%`);
  console.log(`  Flashloan Fee:         ${evParams.flashloanFeePct * 100}%`);
  console.log(`  Fixed Gas USD:         $${evParams.fixedGasUsd}`);
  if (evParams.slippageBufferPct !== undefined) {
    console.log(`  Slippage Buffer:       ${evParams.slippageBufferPct * 100}%`);
  }

  const payload = loadCandidatesPayload();
  const candidates = normalizeCandidates(payload);
  const { filtered, stats } = filterCandidatesWithStats(candidates, params);

  console.log('\n📊 Filter Statistics:');
  console.log(`  Total candidates:           ${stats.total}`);
  console.log(`  Filtered (passed):          ${stats.filtered}`);
  console.log(`  Rejected (total):           ${stats.total - stats.filtered}`);
  console.log('');
  console.log('  Rejection Reasons:');
  console.log(`    EV too low (<= ${params.minEv}):      ${stats.reasons.evTooLow}`);
  console.log(`    TTL too high (> ${params.maxTtlMin} min): ${stats.reasons.ttlTooHigh}`);
  console.log(`    Hazard too low (<= ${params.minHazard}):  ${stats.reasons.hazardTooLow}`);
  console.log(`    Missing health ratio:       ${stats.reasons.missingHealth}`);
  console.log(`    Missing borrow value:       ${stats.reasons.missingBorrow}`);
  console.log('');
  console.log('  Force-Included:');
  console.log(`    Liquidatable now:           ${stats.forcedIn.liquidatable}`);

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
