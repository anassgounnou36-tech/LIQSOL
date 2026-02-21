/**
 * Candidate Selector Module
 * 
 * Takes scored obligations and ranks them by priority for liquidation monitoring.
 * Exposes distance-to-liquidation metrics and simple heuristics for targeting.
 */

import { scoreHazard } from '../predict/hazardScorer.js';
import { computeEV, EvParams } from '../predict/evCalculator.js';
import { estimateTtlString } from '../predict/ttlEstimator.js';

export interface ScoredObligation {
  obligationPubkey: string;
  ownerPubkey: string;
  healthRatio: number; // e.g., 0.95 liquidatable, 1.02 near threshold
  healthRatioRaw?: number; // unclamped health ratio for more precise EV calculations
  liquidationEligible: boolean;
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
  borrowValueRecomputed?: number;
  collateralValueRecomputed?: number;
  borrowValueProtocol?: number;
  collateralValueProtocol?: number;
  // optionally: underlying detail for validation
}

export interface Candidate extends ScoredObligation {
  priorityScore: number;
  distanceToLiquidation: number; // max(0, HR - 1)
  predictedLiquidatableSoon: boolean; // HR <= nearThreshold
  priceMoveToLiquidationPct?: number; // heuristic for SOL/USDC pairs (optional for PR8)
  hazard?: number; // PR 8.5: hazard score when using EV ranking
  ev?: number; // PR 8.5: expected value when using EV ranking
  forecast?: { // PR 8.6: forecast object with EV, TTL, and rank
    evScore: number;
    timeToLiquidation: string;
    rank?: number;
  };
}

export interface CandidateSelectorConfig {
  nearThreshold?: number; // default 1.02
  // PR 8.5: EV-based ranking configuration (opt-in)
  useEvRanking?: boolean; // default false
  minBorrowUsd?: number; // default 10
  hazardAlpha?: number; // default 25
  evParams?: EvParams; // EV calculation parameters
  // PR 8.6: Forecast caching and TTL parameters
  forecastTtlMs?: number; // default 300000 (5 minutes)
  ttlSolDropPctPerMin?: number; // default 0.2
  ttlMaxDropPct?: number; // default 20
}

// PR 8.6: Simple in-memory forecast cache with TTL
// Note: This is a bounded cache that only grows with unique obligation keys.
// In production, the number of liquidatable/near-liquidatable obligations is typically
// small (< 100), so memory impact is minimal. For long-running processes with high
// churn, consider implementing periodic cleanup of expired entries.
type ForecastEntry = {
  evScore: number;
  timeToLiquidation: string;
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
 *   - Filter by minBorrowUsd (unless liquidatable)
 *   - Sort by EV descending
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
      solDropPctPerMin: config.ttlSolDropPctPerMin ?? 0.2,
      maxDropPct: config.ttlMaxDropPct ?? 20,
    };

    const withEvAndForecast = candidates
      .map((c) => {
        // Use healthRatioRaw if available for more precise calculations
        const hr = c.healthRatioRaw ?? c.healthRatio;
        const hazard = scoreHazard(hr, alpha);
        const ev = computeEV(c.borrowValueUsd, hazard, evParams);
        
        // PR 8.6: Forecast TTL caching
        const key = c.obligationPubkey;
        const cached = getCachedForecast(key, ttlMs);
        let ttlString = cached?.timeToLiquidation;
        // Validate cached EV score matches current calculation (within small tolerance)
        if (ttlString && cached && Math.abs(cached.evScore - ev) < 0.01) {
          // Use cached TTL
        } else {
          // Recalculate TTL if cache miss or EV changed
          ttlString = estimateTtlString(c, ttlOpts);
          setCachedForecast(key, { evScore: ev, timeToLiquidation: ttlString, atMs: Date.now() });
        }
        
        return { 
          ...c, 
          hazard, 
          ev, 
          forecast: { evScore: ev, timeToLiquidation: ttlString } 
        };
      })
      .filter((c) => c.liquidationEligible || c.borrowValueUsd >= minBorrow)
      .sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0));

    // PR 8.6: Inject rank after final sort
    return withEvAndForecast.map((c, idx) => ({
      ...c,
      forecast: { ...(c.forecast ?? { evScore: 0, timeToLiquidation: 'unknown' }), rank: idx + 1 },
    }));
  }

  // Default: sort by priorityScore
  return candidates.sort((a, b) => b.priorityScore - a.priorityScore);
}
