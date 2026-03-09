import fs from 'fs';
import path from 'path';
import { filterCandidatesWithStats, normalizeCandidates } from '../scheduler/txFilters.js';
import { buildPlanFromCandidate, type FlashloanPlan } from '../scheduler/txBuilder.js';
import { enqueuePlans, replaceQueue } from '../scheduler/txScheduler.js';
import { type PlanEvParams } from '../predict/evCalculator.js';
import { logger } from '../observability/logger.js';
import { emitBotEvent, makePlanFingerprint } from '../observability/botTelemetry.js';
import { maybeNotifyForBotEvent } from '../notify/notificationRouter.js';

export interface BuildQueueOptions {
  candidatesPath?: string;
  outputPath?: string;
  minEv?: number;
  maxTtlMin?: number;
  minHazard?: number;
  hazardAlpha?: number;
  ttlVolatileMovePctPerMin?: number;
  ttlStableMovePctPerMin?: number;
  ttlMaxMovePct?: number;
  ttlDropPerMinPct?: number;
  ttlMaxDropPct?: number;
  evParams?: PlanEvParams;
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
    ttlVolatileMovePctPerMin = getEnvNum(
      'TTL_VOLATILE_MOVE_PCT_PER_MIN',
      getEnvNum('TTL_SOL_DROP_PCT_PER_MIN', 0.2)
    ),
    ttlStableMovePctPerMin = getEnvNum('TTL_STABLE_MOVE_PCT_PER_MIN', 0.02),
    ttlMaxMovePct = getEnvNum('TTL_MAX_DROP_PCT', 20),
    ttlDropPerMinPct = getEnvNum('TTL_SOL_DROP_PCT_PER_MIN', 0.2),
    ttlMaxDropPct = getEnvNum('TTL_MAX_DROP_PCT', 20),
    evParams = {
      closeFactor: getEnvNum('EV_CLOSE_FACTOR', 0.5),
      liquidationBonusPct: getEnvNum('EV_LIQUIDATION_BONUS_PCT', 0.05),
      flashloanFeePct: getEnvNum('EV_FLASHLOAN_FEE_PCT', 0.002),
      fixedGasUsd: getEnvNum('EV_FIXED_GAS_USD', 0.5),
      slippageBufferPct: getOptionalEnvNum('EV_SLIPPAGE_BUFFER_PCT'),
      minLiquidationBonusPctFallback: getEnvNum('EV_MIN_LIQUIDATION_BONUS_PCT', 0.02),
      bonusFullSeverityHrGap: getEnvNum('EV_BONUS_FULLY_SEVERE_HR_GAP', 0.10),
      sameMintSlippageBufferPct: getOptionalEnvNum('EV_SAME_MINT_SLIPPAGE_BUFFER_PCT') ?? 0,
    },
    flashloanMint = 'USDC',
    mode = (process.env.QUEUE_BUILD_MODE as 'replace' | 'merge') || 'replace', // Default to replace for production
  } = options;
  const resolvedOutputPath = path.resolve(outputPath);
  let previousQueue: FlashloanPlan[] = [];
  if (fs.existsSync(resolvedOutputPath)) {
    try {
      previousQueue = JSON.parse(fs.readFileSync(resolvedOutputPath, 'utf8')) as FlashloanPlan[];
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), resolvedOutputPath },
        'Failed to parse previous queue file for telemetry diff',
      );
    }
  }

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
    ttlVolatileMovePctPerMin,
    ttlStableMovePctPerMin,
    ttlMaxMovePct,
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
  const plans = filtered.map((c) => buildPlanFromCandidate(c, flashloanMint as "USDC" | "SOL" | undefined));
  
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
  let queued: FlashloanPlan[];
  if (mode === 'replace') {
    queued = await replaceQueue(validPlans);
    logger.info('Queue replaced (replace mode)');
  } else {
    queued = enqueuePlans(validPlans);
    logger.info('Plans merged into queue (merge mode)');
  }

  await emitBotEvent({
    ts: new Date().toISOString(),
    kind: 'queue-refresh-summary',
    candidateCount: stats.total,
    filteredCount: stats.filtered,
    validPlanCount: validPlans.length,
    queueSize: queued.length,
    reasons: stats.reasons as Record<string, number>,
  });

  const previousFingerprints = new Set(previousQueue.map((plan) => makePlanFingerprint(plan)));
  const newlyAdded = queued
    .filter((plan) => !previousFingerprints.has(makePlanFingerprint(plan)))
    .sort((a, b) => Number(b.ev ?? 0) - Number(a.ev ?? 0));
  const maxQueuePerRefreshRaw = Number(process.env.TELEGRAM_NOTIFY_MAX_QUEUE_PER_REFRESH);
  const maxQueuePerRefresh =
    Number.isFinite(maxQueuePerRefreshRaw) && maxQueuePerRefreshRaw >= 0
      ? maxQueuePerRefreshRaw
      : 3;

  for (const plan of newlyAdded.slice(0, maxQueuePerRefresh)) {
    const event = {
      ts: new Date().toISOString(),
      kind: 'queue-opportunity-added' as const,
      planKey: plan.key,
      obligationPubkey: plan.obligationPubkey,
      repayMint: plan.repayMint,
      collateralMint: plan.collateralMint,
      ev: Number(plan.ev ?? 0),
      ttlMin: plan.ttlMin ?? null,
      ttlStr: plan.ttlStr ?? null,
      hazard: Number(plan.hazard ?? 0),
      queueSize: queued.length,
      estimatedProfitUsd: plan.evProfitUsd ?? null,
      estimatedCostUsd: plan.evCostUsd ?? null,
      estimatedNetUsd: (plan.evProfitUsd ?? 0) - (plan.evCostUsd ?? 0),
      expectedValueUsd: plan.ev,
    };
    await emitBotEvent(event);
    await maybeNotifyForBotEvent(event);
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
