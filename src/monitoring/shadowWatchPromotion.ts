import { loadEnv, loadReadonlyEnv } from '../config/env.js';
import { PublicKey } from '@solana/web3.js';
import { getKlendSdkVerifier } from '../engine/klendSdkVerifier.js';
import { isLiquidatable } from '../math/liquidation.js';
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
  verifiedByKlend: number;
  admittedByKlend: number;
  enqueued: number;
  rejectedReasons: Record<string, number>;
}

type PromotionCandidate = ScoredObligation & {
  rankBucket?: 'liquidatable' | 'near-ready' | 'medium-horizon' | 'far-horizon' | 'legacy-or-unknown';
  forecast?: {
    ttlMinutes?: number | null;
    timeToLiquidation?: string;
    model?: string;
    confidence?: 'high' | 'medium' | 'low';
    driverMint?: string;
    driverSide?: 'deposit' | 'borrow';
    requiredMovePct?: number;
  };
  healthSource?: string;
  healthSourceUsed?: string;
  healthSourceVerified?: string;
};

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
  const shadowPromotionVerifyEnabled = (env.SHADOW_PROMOTION_KLEND_VERIFY_ENABLED ?? 'true') === 'true';
  const shadowPromotionVerifyTopK = Math.max(0, Number(env.SHADOW_PROMOTION_KLEND_VERIFY_TOPK ?? 5));
  const shadowPromotionVerifyMaxTtlMin = Number(env.SHADOW_PROMOTION_KLEND_VERIFY_MAX_TTL_MIN ?? 15);

  const consideredCandidates: PromotionCandidate[] = [];
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
    const candidateForSelection: PromotionCandidate = {
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
      rankBucket: item.rankBucket,
      forecast: item.forecast,
      healthSource: item.healthSource,
      healthSourceUsed: item.healthSourceUsed,
      healthSourceVerified: item.healthSourceVerified,
    };
    consideredCandidates.push(candidateForSelection);
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
    shadowPromotionNotInKlendVerifyTopK: 0,
    shadowPromotionKlendMissingOwner: 0,
    shadowPromotionKlendHealthy: 0,
    shadowPromotionKlendVerifyError: 0,
    invalidPlans: 0,
  };

  const klendAdmissionCandidates: PromotionCandidate[] = [];
  let verifiedByKlend = 0;
  let admittedByKlend = 0;
  if (shadowPromotionVerifyEnabled) {
    const eligibleForAdmission = queueFilter.filtered.filter((candidate) => {
      const rankBucket = candidate.rankBucket;
      if (rankBucket === 'liquidatable' || rankBucket === 'near-ready') return true;
      const rawForecastTtl = candidate?.forecast?.ttlMinutes;
      if (rawForecastTtl == null) return false;
      const forecastTtl = Number(rawForecastTtl);
      return Number.isFinite(forecastTtl) && forecastTtl <= shadowPromotionVerifyMaxTtlMin;
    });
    const admissionPool = eligibleForAdmission.slice(0, shadowPromotionVerifyTopK);
    rejectedReasons.shadowPromotionNotInKlendVerifyTopK += Math.max(0, queueFilter.filtered.length - admissionPool.length);

    const verifier = getKlendSdkVerifier({
      rpcUrl: env.RPC_PRIMARY,
      marketPubkey: new PublicKey(readonlyEnv.KAMINO_MARKET_PUBKEY),
      programId: new PublicKey(readonlyEnv.KAMINO_KLEND_PROGRAM_ID),
      cacheTtlMs: Number(env.LIQSOL_RECOMPUTED_VERIFY_TTL_MS ?? 15000),
    });

    for (const candidate of admissionPool) {
      const obligationId = String(candidate.obligationPubkey ?? candidate.key ?? 'unknown');
      if (!candidate.ownerPubkey) {
        rejectedReasons.shadowPromotionKlendMissingOwner++;
        logger.info(
          `[ShadowPromotion] klend-admission obligation=${obligationId} sdkHr=n/a admitted=false reason=missing-owner`,
        );
        continue;
      }

      const verification = await verifier.verify({
        obligationPubkey: String(candidate.obligationPubkey ?? candidate.key ?? ''),
        ownerPubkey: String(candidate.ownerPubkey),
      });
      if (!verification.ok) {
        rejectedReasons.shadowPromotionKlendVerifyError++;
        logger.info(
          `[ShadowPromotion] klend-admission obligation=${obligationId} sdkHr=n/a admitted=false reason=verify-error`,
        );
        continue;
      }

      verifiedByKlend++;
      if (verification.healthRatioSdk < 1) {
        admittedByKlend++;
        klendAdmissionCandidates.push({
          ...candidate,
          healthRatio: verification.healthRatioSdk,
          healthRatioRaw: verification.healthRatioSdkRaw,
          liquidationEligible: isLiquidatable(verification.healthRatioSdk),
          healthSourceUsed: 'klend-sdk',
          healthSource: 'klend-sdk',
          healthSourceVerified: 'klend-sdk',
        });
        logger.info(
          `[ShadowPromotion] klend-admission obligation=${obligationId} sdkHr=${verification.healthRatioSdk.toFixed(6)} admitted=true reason=eligible`,
        );
      } else {
        rejectedReasons.shadowPromotionKlendHealthy++;
        logger.info(
          `[ShadowPromotion] klend-admission obligation=${obligationId} sdkHr=${verification.healthRatioSdk.toFixed(6)} admitted=false reason=healthy`,
        );
      }
    }
  } else {
    klendAdmissionCandidates.push(...queueFilter.filtered);
  }

  const rerankedPostAdmission = selectCandidates(klendAdmissionCandidates, selectorConfig);
  const { passed: selectedLegPassedAfterKlend } = filterCandidatesBySelectedLegUsd(rerankedPostAdmission, {
    minSelectedRepayUsd: Number(env.MIN_SELECTED_REPAY_USD ?? 0),
    minSelectedCollateralUsd: Number(env.MIN_SELECTED_COLLATERAL_USD ?? 0),
  });
  const queueFilterAfterKlend = filterCandidatesWithStats(selectedLegPassedAfterKlend, {
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

  const candidatePlans = queueFilterAfterKlend.filtered.map((candidate) => buildPlanFromCandidate(candidate));
  const validPlans = candidatePlans.filter(
    (plan) =>
      Boolean(plan.key) &&
      Boolean(plan.obligationPubkey) &&
      Boolean(plan.repayReservePubkey) &&
      Boolean(plan.collateralReservePubkey),
  );
  const invalidPlanCount = candidatePlans.length - validPlans.length;
  rejectedReasons.invalidPlans = invalidPlanCount;

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

  logger.info(
    {
      watchedKeys: uniqueWatchOnlyKeys.length,
      considered: consideredCandidates.length,
      ranked: ranked.length,
      queueEligible: queueFilter.filtered.length,
      verifiedByKlend,
      admittedByKlend,
      enqueued: newlyAdded.length,
      rejectedReasons,
    },
    'Shadow watch promotion batch',
  );

  return {
    considered: consideredCandidates.length,
    ranked: ranked.length,
    queueEligible: queueFilter.filtered.length,
    verifiedByKlend,
    admittedByKlend,
    enqueued: newlyAdded.length,
    rejectedReasons,
  };
}
