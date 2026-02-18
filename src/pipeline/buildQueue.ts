import fs from 'fs';
import path from 'path';
import { filterCandidatesWithStats, normalizeCandidates } from '../scheduler/txFilters.js';
import { buildPlanFromCandidate } from '../scheduler/txBuilder.js';
import { enqueuePlans, replaceQueue } from '../scheduler/txScheduler.js';
import { type EvParams } from '../predict/evCalculator.js';
import { logger } from '../observability/logger.js';

export interface BuildQueueOptions {
  candidatesPath?: string;
  outputPath?: string;
  minEv?: number;
  maxTtlMin?: number;
  minHazard?: number;
  hazardAlpha?: number;
  ttlDropPerMinPct?: number;
  ttlMaxDropPct?: number;
  evParams?: EvParams;
  flashloanMint?: string;
  mode?: 'replace' | 'merge'; // New: support replace mode for production
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

/**
 * Shared pipeline function to build tx_queue.json from candidates.json
 * Uses existing scheduler filters/EV/TTL logic from test_scheduler_with_forecast
 */
export async function buildQueue(options: BuildQueueOptions = {}): Promise<void> {
  const {
    candidatesPath = 'data/candidates.json',
    outputPath = 'data/tx_queue.json',
    minEv = getEnvNum('SCHED_MIN_EV', 0),
    maxTtlMin = getEnvNum('SCHED_MAX_TTL_MIN', 10),
    minHazard = getEnvNum('SCHED_MIN_HAZARD', 0.05),
    hazardAlpha = getEnvNum('HAZARD_ALPHA', 25),
    ttlDropPerMinPct = getEnvNum('TTL_SOL_DROP_PCT_PER_MIN', 0.2),
    ttlMaxDropPct = getEnvNum('TTL_MAX_DROP_PCT', 20),
    evParams = {
      closeFactor: getEnvNum('EV_CLOSE_FACTOR', 0.5),
      liquidationBonusPct: getEnvNum('EV_LIQUIDATION_BONUS_PCT', 0.05),
      flashloanFeePct: getEnvNum('EV_FLASHLOAN_FEE_PCT', 0.002),
      fixedGasUsd: getEnvNum('EV_FIXED_GAS_USD', 0.5),
      slippageBufferPct: getOptionalEnvNum('EV_SLIPPAGE_BUFFER_PCT'),
    },
    flashloanMint = 'USDC',
    mode = (process.env.QUEUE_BUILD_MODE as 'replace' | 'merge') || 'replace', // Default to replace for production
  } = options;

  // Load candidates
  const candidatesFile = path.resolve(candidatesPath);
  if (!fs.existsSync(candidatesFile)) {
    throw new Error(`Missing ${candidatesFile}. Run snapshot:candidates first.`);
  }

  logger.info({ path: candidatesFile }, 'Loading candidates');
  const payload = JSON.parse(fs.readFileSync(candidatesFile, 'utf8'));
  const candidates = normalizeCandidates(payload);

  // Filter with stats
  const params = {
    minEv,
    maxTtlMin,
    minHazard,
    hazardAlpha,
    evParams,
    ttlDropPerMinPct,
    ttlMaxDropPct,
  };

  logger.info({ params }, 'Applying scheduler filters');
  const { filtered, stats } = filterCandidatesWithStats(candidates, params);

  logger.info(
    {
      total: stats.total,
      filtered: stats.filtered,
      rejected: stats.total - stats.filtered,
      reasons: stats.reasons,
      forcedIn: stats.forcedIn,
    },
    'Filter results'
  );

  // Build plans from candidates
  const plans = filtered.map((c) => buildPlanFromCandidate(c, flashloanMint));
  
  // Validate plans - drop those missing reserve pubkeys with reason
  const validPlans = [];
  const droppedPlans = [];
  
  for (const plan of plans) {
    const missingFields: string[] = [];
    if (!plan.repayReservePubkey) missingFields.push('repayReservePubkey');
    if (!plan.collateralReservePubkey) missingFields.push('collateralReservePubkey');
    
    if (missingFields.length > 0) {
      droppedPlans.push({
        obligationPubkey: plan.obligationPubkey,
        reason: `Missing fields: ${missingFields.join(', ')}`,
      });
    } else {
      validPlans.push(plan);
    }
  }
  
  // Report validation results
  if (droppedPlans.length > 0) {
    logger.warn(
      { dropped: droppedPlans.length, reasons: droppedPlans.slice(0, 3) },
      'Some plans dropped due to missing reserve pubkeys'
    );
  } else {
    logger.info('All plans have complete reserve pubkey information');
  }
  
  // Enqueue or replace plans based on mode
  let queued: any[];
  if (mode === 'replace') {
    queued = await replaceQueue(validPlans);
    logger.info('Queue replaced (replace mode)');
  } else {
    queued = enqueuePlans(validPlans);
    logger.info('Plans merged into queue (merge mode)');
  }
  
  logger.info(
    { 
      path: outputPath, 
      validPlans: validPlans.length, 
      queueSize: queued.length,
      mode,
    },
    'Queue built successfully'
  );
}
