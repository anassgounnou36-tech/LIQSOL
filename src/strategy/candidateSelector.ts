/**
 * Candidate Selector Module
 * 
 * Takes scored obligations and ranks them by priority for liquidation monitoring.
 * Exposes distance-to-liquidation metrics and simple heuristics for targeting.
 */

import { scoreHazard } from '../predict/hazardScorer.js';
import { estimatePlanEv, type PlanEvParams } from '../predict/evCalculator.js';
import type { PairAwareTtlContext } from '../predict/ttlContext.js';
import type { PlanAwareEvContext } from '../predict/evContext.js';
import { estimateTtl } from '../predict/ttlEstimator.js';

export interface ScoredObligation {
  obligationPubkey: string;
  ownerPubkey: string;
  healthRatio: number; // e.g., 0.95 liquidatable, 1.02 near threshold
  healthRatioRaw?: number; // unclamped health ratio for more precise EV calculations
  liquidationEligible: boolean;
  liquidationEligibleProtocol?: boolean;
  borrowValueUsd: number;
  collateralValueUsd: number;
  // PR: Reserve pubkeys from obligation borrows/deposits
  repayReservePubkey?: string;
  collateralReservePubkey?: string;
  primaryBorrowMint?: string;
  primaryCollateralMint?: string;
  // Dual health ratio sources
  healthRatioRecomputed?: number;
  healthRatioRecomputedRaw?: number;
  healthRatioProtocol?: number;
  healthRatioProtocolRaw?: number;
  healthRatioDiff?: number;
  healthSource?: string;
  healthSourceUsed?: string;
  healthSourceConfigured?: string;
  healthRatioHybrid?: number;
  healthRatioHybridRaw?: number;
  healthRatioVerified?: number;
  healthRatioVerifiedRaw?: number;
  healthSourceVerified?: string;
  liquidationEligibleVerified?: boolean;
  borrowUsdAdjVerified?: number;
  collateralUsdAdjVerified?: number;
  borrowValueRecomputed?: number;
  collateralValueRecomputed?: number;
  borrowValueProtocol?: number;
  collateralValueProtocol?: number;
  borrowValueHybrid?: number;
  collateralValueHybrid?: number;
  totalBorrowUsdRecomputed?: number;
  totalCollateralUsdRecomputed?: number;
  totalBorrowUsdAdjRecomputed?: number;
  totalCollateralUsdAdjRecomputed?: number;
  totalBorrowUsdProtocol?: number;
  totalCollateralUsdProtocol?: number;
  totalBorrowUsdAdjProtocol?: number;
  totalCollateralUsdAdjProtocol?: number;
  lastUpdateSlot?: string;
  slotLag?: number;
  hybridDisabledReason?: string;
  assets?: string[];
  ttlContext?: PairAwareTtlContext;
  evContext?: PlanAwareEvContext;
  // optionally: underlying detail for validation
}

export interface Candidate extends ScoredObligation {
  priorityScore: number;
  distanceToLiquidation: number; // max(0, HR - 1)
  predictedLiquidatableSoon: boolean; // HR <= nearThreshold
  priceMoveToLiquidationPct?: number; // heuristic for SOL/USDC pairs (optional for PR8)
  hazard?: number; // PR 8.5: hazard score when using EV ranking
  ev?: number; // PR 8.5: expected value when using EV ranking
  evModel?: 'selected-leg-dynamic-bonus' | 'legacy-flat';
  evRepayCapUsd?: number;
  evGrossBonusPct?: number;
  evNetBonusPct?: number;
  evProfitUsd?: number;
  evCostUsd?: number;
  evSwapRequired?: boolean;
  rankBucket?: 'liquidatable' | 'near-ready' | 'medium-horizon' | 'far-horizon' | 'legacy-or-unknown';
  forecast?: { // PR 8.6: forecast object with EV, TTL, and rank
    evScore: number;
    timeToLiquidation: string;
    ttlMinutes?: number | null;
    rank?: number;
    model?: string;
    confidence?: 'high' | 'medium' | 'low';
    driverMint?: string;
    driverSide?: 'deposit' | 'borrow';
    requiredMovePct?: number;
  };
}

export interface CandidateSelectorConfig {
  nearThreshold?: number; // default 1.02
  // PR 8.5: EV-based ranking configuration (opt-in)
  useEvRanking?: boolean; // default false
  minBorrowUsd?: number; // default 10
  hazardAlpha?: number; // default 25
  evParams?: PlanEvParams; // EV calculation parameters
  // PR 8.6: Forecast caching and TTL parameters
  forecastTtlMs?: number; // default 300000 (5 minutes)
  ttlVolatileMovePctPerMin?: number; // default 0.2
  ttlStableMovePctPerMin?: number; // default 0.02
  ttlMaxMovePct?: number; // default 20
  legacySolDropPctPerMin?: number; // default 0.2
}

// PR 8.6: Simple in-memory forecast cache with TTL
// Note: This is a bounded cache that only grows with unique obligation keys.
// In production, the number of liquidatable/near-liquidatable obligations is typically
// small (< 100), so memory impact is minimal. For long-running processes with high
// churn, consider implementing periodic cleanup of expired entries.
type ForecastEntry = {
  evScore: number;
  timeToLiquidation: string;
  model?: string;
  confidence?: 'high' | 'medium' | 'low';
  driverMint?: string;
  driverSide?: 'deposit' | 'borrow';
  requiredMovePct?: number;
  rank?: number;
  atMs: number;
};

const forecastCache = new Map<string, ForecastEntry>();

function getCachedForecast(key: string, ttlMs: number): ForecastEntry | undefined {
  const e = forecastCache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.atMs > ttlMs) return undefined;
  return e;
}

function setCachedForecast(key: string, f: ForecastEntry) {
  forecastCache.set(key, f);
}

function parseTtlMinutes(ttlStr?: string): number | null {
  if (!ttlStr || ttlStr === 'unknown') return null;
  const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(ttlStr);
  if (!m) return null;
  const minutes = Number(m[1] || 0);
  const seconds = Number(m[2] || 0);
  return minutes + seconds / 60;
}

const BUCKET_ORDER = {
  'liquidatable': 0,
  'near-ready': 1,
  'medium-horizon': 2,
  'far-horizon': 3,
  'legacy-or-unknown': 4,
} as const;

function classifyRankBucket(
  candidate: Candidate,
  nearThreshold: number,
  ttlMinutes: number | null,
): Candidate['rankBucket'] {
  const healthRatio = Number(candidate.healthRatio ?? 0);
  const liquidatable = candidate.liquidationEligible === true || healthRatio < 1;
  if (liquidatable) {
    return 'liquidatable';
  }
  if (healthRatio <= nearThreshold || (ttlMinutes !== null && ttlMinutes <= 10)) {
    return 'near-ready';
  }
  if (ttlMinutes !== null && ttlMinutes <= 60) {
    return 'medium-horizon';
  }
  if (candidate.forecast?.model !== 'legacy-global') {
    return 'far-horizon';
  }
  return 'legacy-or-unknown';
}

/**
 * Select and rank candidates from scored obligations.
 * 
 * Priority scoring logic:
 * - Default mode (useEvRanking=false):
 *   - Liquidatable accounts get massive urgency boost (1e6)
 *   - Higher urgency for accounts closer to liquidation threshold (1 / (distance + 0.001))
 *   - Size based on borrow value (log10 of USD value, stabilized at $10 minimum)
 *   - Results sorted descending by priorityScore = urgency * size
 * 
 * - EV mode (useEvRanking=true):
 *   - Compute hazard score based on health ratio
 *   - Compute expected value (EV) based on hazard, position size, and liquidation parameters
 *   - Assign urgency bucket (liquidatable, near-ready, medium-horizon, far-horizon, legacy/unknown)
 *   - Filter by minBorrowUsd (unless liquidatable)
 *   - Sort bucket-first, then EV within bucket
 * 
 * @param scored Array of scored obligations
 * @param config Configuration options
 * @returns Array of candidates sorted by priority (highest first)
 */
export function selectCandidates(
  scored: ScoredObligation[],
  config: CandidateSelectorConfig = {}
): Candidate[] {
  const near = config.nearThreshold ?? 1.02;
  const useEv = config.useEvRanking ?? false;

  // Start with base filtering and mapping
  const candidates: Candidate[] = scored
    .filter((o) => Number.isFinite(o.healthRatio) && Number.isFinite(o.borrowValueUsd))
    .map((o) => {
      const distToThreshold = Math.abs(o.healthRatio - 1);
      const depthBelow = Math.max(0, 1 - o.healthRatio);
      // Liquidatable: urgency increases with depth below 1 (deeper = more profitable/urgent)
      // Non-liquidatable: urgency increases as HR approaches 1 from above
      const urgency = o.liquidationEligible
        ? 1e6 * (depthBelow + 0.001)
        : 1 / (Math.max(0, o.healthRatio - 1) + 0.001);
      const size = Math.log10(Math.max(10, o.borrowValueUsd));
      const priorityScore = urgency * size;
      const predictedLiquidatableSoon = !o.liquidationEligible && o.healthRatio <= near;

      return {
        ...o,
        distanceToLiquidation: distToThreshold,
        priorityScore,
        predictedLiquidatableSoon,
        // priceMoveToLiquidationPct can be populated downstream when mint info is available (optional for PR8)
      };
    });

  // PR 8.5: If EV ranking is enabled, compute hazard/EV and re-sort
  if (useEv && config.evParams) {
    const minBorrow = config.minBorrowUsd ?? 10;
    const alpha = config.hazardAlpha ?? 25;
    const evParams = config.evParams; // TypeScript narrowing
    const ttlMs = config.forecastTtlMs ?? 300000; // Default 5 minutes
    const ttlOpts = {
      volatileMovePctPerMin: config.ttlVolatileMovePctPerMin ?? 0.2,
      stableMovePctPerMin: config.ttlStableMovePctPerMin ?? 0.02,
      maxMovePct: config.ttlMaxMovePct ?? 20,
      legacySolDropPctPerMin: config.legacySolDropPctPerMin ?? 0.2,
    };

    const withEvAndForecast = candidates
      .map((c) => {
        // Use healthRatioRaw if available for more precise calculations
        const hr = c.healthRatioRaw ?? c.healthRatio;
        const hazard = scoreHazard(hr, alpha);
        const evEstimate = estimatePlanEv(c, hazard, evParams);
        const ev = evEstimate.ev;
        
        // PR 8.6: Forecast TTL caching
        const key = c.obligationPubkey;
        const cached = getCachedForecast(key, ttlMs);
        let ttlString = cached?.timeToLiquidation;
        let ttlModel = cached?.model;
        let ttlConfidence = cached?.confidence;
        let ttlDriverMint = cached?.driverMint;
        let ttlDriverSide = cached?.driverSide;
        let ttlRequiredMovePct = cached?.requiredMovePct;
        // Validate cached EV score matches current calculation (within small tolerance)
        if (ttlString && cached && Math.abs(cached.evScore - ev) < 0.01) {
          // Use cached TTL
        } else {
          // Recalculate TTL if cache miss or EV changed
          const ttlEstimate = estimateTtl(c, ttlOpts);
          ttlString = ttlEstimate.ttlString;
          ttlModel = ttlEstimate.model;
          ttlConfidence = ttlEstimate.confidence;
          ttlDriverMint = ttlEstimate.driverMint;
          ttlDriverSide = ttlEstimate.driverSide;
          ttlRequiredMovePct = ttlEstimate.requiredMovePct;
          setCachedForecast(key, {
            evScore: ev,
            timeToLiquidation: ttlString,
            model: ttlModel,
            confidence: ttlConfidence,
            driverMint: ttlDriverMint,
            driverSide: ttlDriverSide,
            requiredMovePct: ttlRequiredMovePct,
            atMs: Date.now(),
          });
        }

        return { 
          ...c, 
          hazard, 
          ev, 
          evModel: evEstimate.breakdown.model,
          evRepayCapUsd: evEstimate.breakdown.repayCapUsd,
          evGrossBonusPct: evEstimate.breakdown.grossBonusPct,
          evNetBonusPct: evEstimate.breakdown.netBonusPct,
          evProfitUsd: evEstimate.breakdown.profitUsd,
          evCostUsd: evEstimate.breakdown.costUsd,
          evSwapRequired: evEstimate.breakdown.swapRequired,
          forecast: {
            evScore: ev,
            timeToLiquidation: ttlString,
            model: ttlModel,
            confidence: ttlConfidence,
            driverMint: ttlDriverMint,
            driverSide: ttlDriverSide,
            requiredMovePct: ttlRequiredMovePct,
          }
        };
      })
      .filter((c) => c.liquidationEligible || c.borrowValueUsd >= minBorrow)
      .map((c) => {
        const ttlMinutes = parseTtlMinutes(c.forecast?.timeToLiquidation);
        const rankBucket = classifyRankBucket(c, near, ttlMinutes);
        return {
          ...c,
          rankBucket,
          forecast: {
            ...(c.forecast ?? { evScore: c.ev ?? 0, timeToLiquidation: 'unknown' }),
            ttlMinutes,
          },
        };
      })
      .sort((a, b) => {
        const aBucket = BUCKET_ORDER[a.rankBucket ?? 'legacy-or-unknown'];
        const bBucket = BUCKET_ORDER[b.rankBucket ?? 'legacy-or-unknown'];
        if (aBucket !== bBucket) return aBucket - bBucket;

        const evDiff = (b.ev ?? 0) - (a.ev ?? 0);
        if (evDiff !== 0) return evDiff;

        const aTtl = a.forecast?.ttlMinutes;
        const bTtl = b.forecast?.ttlMinutes;
        if (aTtl !== null && aTtl !== undefined && bTtl !== null && bTtl !== undefined) {
          if (aTtl !== bTtl) return aTtl - bTtl;
        }

        if (a.healthRatio !== b.healthRatio) return a.healthRatio - b.healthRatio;
        if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore;
        return a.obligationPubkey.localeCompare(b.obligationPubkey);
      });

    // PR 8.6: Inject rank after final sort
    return withEvAndForecast.map((c, idx) => ({
      ...c,
      forecast: { ...(c.forecast ?? { evScore: 0, timeToLiquidation: 'unknown' }), rank: idx + 1 },
    }));
  }

  // Default: sort by priorityScore
  return candidates.sort((a, b) => b.priorityScore - a.priorityScore);
}
