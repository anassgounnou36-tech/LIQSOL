import { loadEnv, loadReadonlyEnv } from '../config/env.js';
import { buildPlanFromCandidate } from '../scheduler/txBuilder.js';
import { enqueuePlans, loadQueue } from '../scheduler/txScheduler.js';
import { filterCandidatesWithStats } from '../scheduler/txFilters.js';
import { selectCandidates, type ScoredObligation } from '../strategy/candidateSelector.js';
import { buildCandidateSelectorConfigFromEnv } from '../strategy/rankCandidatesForSelection.js';
import { filterCandidatesBySelectedLegUsd } from '../strategy/selectedLegFilters.js';
import { emitBotEvent, makePlanFingerprint } from '../observability/botTelemetry.js';
import { maybeNotifyForBotEvent } from '../notify/notificationRouter.js';
import { logger } from '../observability/logger.js';
import type { CandidateLike } from './realtimeForecastUpdater.js';

export interface ShadowPromotionResult {
  considered: number;
  ranked: number;
  queueEligible: number;
  enqueued: number;
  rejectedReasons: Record<string, number>;
}

export async function promoteWatchedCandidatesToQueue(args: {
  keys: string[];
  candidatesByKey: Map<string, CandidateLike>;
}): Promise<ShadowPromotionResult> {
  const env = loadEnv();
  const readonlyEnv = loadReadonlyEnv();
  const queue = loadQueue();
  const queuedKeys = new Set(queue.map((plan) => String(plan.key)));
  const uniqueWatchOnlyKeys = Array.from(new Set(args.keys.filter((key) => key && !queuedKeys.has(key))));

  const selectorConfig = buildCandidateSelectorConfigFromEnv(
    readonlyEnv,
    Number(env.CAND_NEAR ?? 1.02),
  );

  const consideredCandidates: ScoredObligation[] = [];
  for (const key of uniqueWatchOnlyKeys) {
    const item = args.candidatesByKey.get(key);
    if (!item) continue;
    if (
      item.healthRatio == null ||
      item.borrowValueUsd == null ||
      !item.repayReservePubkey ||
      !item.collateralReservePubkey
    ) {
      continue;
    }
    consideredCandidates.push({
      obligationPubkey: key,
      ownerPubkey: item.ownerPubkey ?? '',
      healthRatio: Number(item.healthRatio),
      healthRatioRaw: item.healthRatioRaw != null ? Number(item.healthRatioRaw) : undefined,
      liquidationEligible:
        item.liquidationEligible === true || Number(item.healthRatio) < 1,
      borrowValueUsd: Number(item.borrowValueUsd),
      collateralValueUsd: Number(item.collateralValueUsd ?? 0),
      repayReservePubkey: item.repayReservePubkey,
      collateralReservePubkey: item.collateralReservePubkey,
      primaryBorrowMint: item.primaryBorrowMint,
      primaryCollateralMint: item.primaryCollateralMint,
      assets: item.assets,
      ttlContext: item.ttlContext,
      evContext: item.evContext,
    });
  }

  const ranked = selectCandidates(consideredCandidates, selectorConfig);
  const { passed: selectedLegPassed, stats: selectedLegStats } = filterCandidatesBySelectedLegUsd(ranked, {
    minSelectedRepayUsd: Number(env.MIN_SELECTED_REPAY_USD ?? 0),
    minSelectedCollateralUsd: Number(env.MIN_SELECTED_COLLATERAL_USD ?? 0),
  });
  const ttlVolatileMovePctPerMin = Number(
    env.TTL_VOLATILE_MOVE_PCT_PER_MIN ?? env.TTL_SOL_DROP_PCT_PER_MIN ?? 0.2,
  );
  const queueFilter = filterCandidatesWithStats(selectedLegPassed, {
    minEv: Number(env.SCHED_MIN_EV ?? 0),
    maxTtlMin: Number(env.SCHED_MAX_TTL_MIN ?? 10),
    minHazard: Number(env.SCHED_MIN_HAZARD ?? 0.05),
    hazardAlpha: Number(env.HAZARD_ALPHA ?? 25),
    ttlVolatileMovePctPerMin,
    ttlStableMovePctPerMin: Number(env.TTL_STABLE_MOVE_PCT_PER_MIN ?? 0.02),
    ttlMaxMovePct: Number(env.TTL_MAX_DROP_PCT ?? 20),
    ttlDropPerMinPct: ttlVolatileMovePctPerMin,
    ttlMaxDropPct: Number(env.TTL_MAX_DROP_PCT ?? 20),
    evParams: {
      closeFactor: Number(env.EV_CLOSE_FACTOR ?? 0.5),
      liquidationBonusPct: Number(env.EV_LIQUIDATION_BONUS_PCT ?? 0.05),
      flashloanFeePct: Number(env.EV_FLASHLOAN_FEE_PCT ?? 0.002),
      fixedGasUsd: Number(env.EV_FIXED_GAS_USD ?? 0.5),
      slippageBufferPct: env.EV_SLIPPAGE_BUFFER_PCT ? Number(env.EV_SLIPPAGE_BUFFER_PCT) : undefined,
      minLiquidationBonusPctFallback: Number(env.EV_MIN_LIQUIDATION_BONUS_PCT ?? 0.02),
      bonusFullSeverityHrGap: Number(env.EV_BONUS_FULLY_SEVERE_HR_GAP ?? 0.1),
      sameMintSlippageBufferPct: Number(env.EV_SAME_MINT_SLIPPAGE_BUFFER_PCT ?? 0),
    },
  });

  const candidatePlans = queueFilter.filtered.map((candidate) => buildPlanFromCandidate(candidate));
  const validPlans = candidatePlans.filter(
    (plan) =>
      Boolean(plan.key) &&
      Boolean(plan.obligationPubkey) &&
      Boolean(plan.repayReservePubkey) &&
      Boolean(plan.collateralReservePubkey),
  );
  const invalidPlanCount = candidatePlans.length - validPlans.length;

  const previousQueue = loadQueue();
  const previousFingerprints = new Set(previousQueue.map((plan) => makePlanFingerprint(plan)));
  const queued = enqueuePlans(validPlans);
  const newlyAdded = queued
    .filter((plan) => !previousFingerprints.has(makePlanFingerprint(plan)))
    .sort((a, b) => Number(b.ev ?? 0) - Number(a.ev ?? 0));

  for (const plan of newlyAdded) {
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

  const rejectedReasons: Record<string, number> = {
    missingRequiredFields: uniqueWatchOnlyKeys.length - consideredCandidates.length,
    selectedLegMissingEvContext: selectedLegStats.missingEvContext,
    selectedLegRepayTooSmall: selectedLegStats.repayTooSmall,
    selectedLegCollateralTooSmall: selectedLegStats.collateralTooSmall,
    queueEvTooLow: queueFilter.stats.reasons.evTooLow,
    queueTtlTooHigh: queueFilter.stats.reasons.ttlTooHigh,
    queueHazardTooLow: queueFilter.stats.reasons.hazardTooLow,
    queueMissingHealth: queueFilter.stats.reasons.missingHealth,
    queueMissingBorrow: queueFilter.stats.reasons.missingBorrow,
    invalidPlans: invalidPlanCount,
  };

  logger.info(
    {
      watchedKeys: uniqueWatchOnlyKeys.length,
      considered: consideredCandidates.length,
      ranked: ranked.length,
      queueEligible: queueFilter.filtered.length,
      enqueued: newlyAdded.length,
      rejectedReasons,
    },
    'Shadow watch promotion batch',
  );

  return {
    considered: consideredCandidates.length,
    ranked: ranked.length,
    queueEligible: queueFilter.filtered.length,
    enqueued: newlyAdded.length,
    rejectedReasons,
  };
}
