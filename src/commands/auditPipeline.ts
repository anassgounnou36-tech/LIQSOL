#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { filterCandidatesWithStats, type FilterParams, normalizeCandidates } from '../scheduler/txFilters.js';
import { type PlanEvParams } from '../predict/evCalculator.js';

/**
 * Audit Pipeline Command
 * 
 * Audits the scheduler pipeline by reading data from various stages:
 * - data/obligations.jsonl: Raw obligations from snapshot
 * - data/scored.json: Scored obligations with health ratios
 * - data/candidates.json: Filtered candidates after selection
 * - data/tx_queue.json: Final transaction queue
 * 
 * Prints counts for each stage and filter reason statistics.
 * Handles missing files gracefully by printing "missing" instead of throwing.
 */

interface FileCount {
  file: string;
  count: number | string;
}

function countJsonlLines(filePath: string): number | string {
  if (!fs.existsSync(filePath)) return 'missing';
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim().length > 0);
    return lines.length;
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function countJsonArray(filePath: string): number | string {
  if (!fs.existsSync(filePath)) return 'missing';
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    if (Array.isArray(data)) return data.length;
    if (data.candidates && Array.isArray(data.candidates)) return data.candidates.length;
    if (data.data && Array.isArray(data.data)) return data.data.length;
    return Object.keys(data).length;
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function loadCandidatesForFiltering(): any[] {
  const candidatesPath = path.join(process.cwd(), 'data', 'candidates.json');
  if (!fs.existsSync(candidatesPath)) {
    console.log('  (candidates.json missing - skipping filter stats)');
    return [];
  }
  
  try {
    const content = fs.readFileSync(candidatesPath, 'utf8');
    const data = JSON.parse(content);
    return normalizeCandidates(data);
  } catch (err) {
    console.log(`  (error loading candidates: ${err instanceof Error ? err.message : String(err)})`);
    return [];
  }
}

function getEnvNum(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const num = Number(val);
  return Number.isFinite(num) ? num : defaultValue;
}

function main() {
  console.log('\n=== PIPELINE AUDIT ===\n');

  // Stage counts
  const stages: FileCount[] = [
    { file: 'data/obligations.jsonl', count: countJsonlLines(path.join(process.cwd(), 'data', 'obligations.jsonl')) },
    { file: 'data/scored.json', count: countJsonArray(path.join(process.cwd(), 'data', 'scored.json')) },
    { file: 'data/candidates.json', count: countJsonArray(path.join(process.cwd(), 'data', 'candidates.json')) },
    { file: 'data/tx_queue.json', count: countJsonArray(path.join(process.cwd(), 'data', 'tx_queue.json')) },
  ];

  console.log('Stage Counts:');
  for (const stage of stages) {
    const countStr = typeof stage.count === 'number' ? stage.count.toString().padStart(8) : stage.count.padStart(8);
    console.log(`  ${stage.file.padEnd(30)} ${countStr}`);
  }

  // Filter stats
  console.log('\nFilter Statistics:');
  const candidates = loadCandidatesForFiltering();
  
  if (candidates.length === 0) {
    console.log('  (no candidates available for filtering stats)');
    return;
  }

  // Build filter params from env
  const evParams: PlanEvParams = {
    closeFactor: getEnvNum('EV_CLOSE_FACTOR', 0.5),
    liquidationBonusPct: getEnvNum('EV_LIQUIDATION_BONUS_PCT', 0.05),
    flashloanFeePct: getEnvNum('EV_FLASHLOAN_FEE_PCT', 0.002),
    fixedGasUsd: getEnvNum('EV_FIXED_GAS_USD', 0.5),
    slippageBufferPct: process.env.EV_SLIPPAGE_BUFFER_PCT !== undefined ? getEnvNum('EV_SLIPPAGE_BUFFER_PCT', 0) : undefined,
    minLiquidationBonusPctFallback: getEnvNum('EV_MIN_LIQUIDATION_BONUS_PCT', 0.02),
    bonusFullSeverityHrGap: getEnvNum('EV_BONUS_FULLY_SEVERE_HR_GAP', 0.10),
    sameMintSlippageBufferPct: getEnvNum('EV_SAME_MINT_SLIPPAGE_BUFFER_PCT', 0),
  };

  const filterParams: FilterParams = {
    minEv: getEnvNum('SCHED_MIN_EV', 0),
    maxTtlMin: getEnvNum('SCHED_MAX_TTL_MIN', 10),
    minHazard: getEnvNum('SCHED_MIN_HAZARD', 0.05),
    hazardAlpha: getEnvNum('HAZARD_ALPHA', 25),
    evParams,
    ttlVolatileMovePctPerMin: getEnvNum(
      'TTL_VOLATILE_MOVE_PCT_PER_MIN',
      getEnvNum('TTL_SOL_DROP_PCT_PER_MIN', 0.2)
    ),
    ttlStableMovePctPerMin: getEnvNum('TTL_STABLE_MOVE_PCT_PER_MIN', 0.02),
    ttlMaxMovePct: getEnvNum('TTL_MAX_DROP_PCT', 20),
    ttlDropPerMinPct: getEnvNum('TTL_SOL_DROP_PCT_PER_MIN', 0.2),
    ttlMaxDropPct: getEnvNum('TTL_MAX_DROP_PCT', 20),
  };

  const { stats } = filterCandidatesWithStats(candidates, filterParams);

  console.log(`  Total candidates:           ${stats.total}`);
  console.log(`  Filtered (passed):          ${stats.filtered}`);
  console.log(`  Rejected (total):           ${stats.total - stats.filtered}`);
  console.log('');
  console.log('  Rejection Reasons:');
  console.log(`    EV too low (<= ${filterParams.minEv}):      ${stats.reasons.evTooLow}`);
  console.log(`    TTL too high (> ${filterParams.maxTtlMin} min): ${stats.reasons.ttlTooHigh}`);
  console.log(`    Hazard too low (<= ${filterParams.minHazard}):  ${stats.reasons.hazardTooLow}`);
  console.log(`    Missing health ratio:       ${stats.reasons.missingHealth}`);
  console.log(`    Missing borrow value:       ${stats.reasons.missingBorrow}`);
  console.log('');
  console.log('  Force-Included:');
  console.log(`    Liquidatable now:           ${stats.forcedIn.liquidatable}`);
  console.log('');

  const evDiagnostics = candidates
    .filter((c) =>
      c.evModel !== undefined ||
      c.evRepayCapUsd !== undefined ||
      c.evGrossBonusPct !== undefined ||
      c.evNetBonusPct !== undefined ||
      c.evCostUsd !== undefined ||
      c.evSwapRequired !== undefined
    )
    .slice(0, 10)
    .map((c) => ({
      key: c.key ?? c.obligationPubkey ?? 'unknown',
      evModel: c.evModel ?? 'n/a',
      evRepayCapUsd: c.evRepayCapUsd ?? 'n/a',
      evGrossBonusPct: c.evGrossBonusPct ?? 'n/a',
      evNetBonusPct: c.evNetBonusPct ?? 'n/a',
      evCostUsd: c.evCostUsd ?? 'n/a',
      evSwapRequired: c.evSwapRequired ?? 'n/a',
    }));
  if (evDiagnostics.length > 0) {
    console.log('  EV Diagnostics (candidate metadata):');
    console.table(evDiagnostics);
  }
}

main();
