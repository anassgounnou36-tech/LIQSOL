/**
 * Candidate Selector Module
 * 
 * Takes scored obligations and ranks them by priority for liquidation monitoring.
 * Exposes distance-to-liquidation metrics and simple heuristics for targeting.
 */

import { scoreHazard } from '../predict/hazardScorer.js';
import { computeEV, EvParams } from '../predict/evCalculator.js';

export interface ScoredObligation {
  obligationPubkey: string;
  ownerPubkey: string;
  healthRatio: number; // e.g., 0.95 liquidatable, 1.02 near threshold
  healthRatioRaw?: number; // unclamped health ratio for more precise EV calculations
  liquidationEligible: boolean;
  borrowValueUsd: number;
  collateralValueUsd: number;
  // optionally: underlying detail for validation
}

export interface Candidate extends ScoredObligation {
  priorityScore: number;
  distanceToLiquidation: number; // max(0, HR - 1)
  predictedLiquidatableSoon: boolean; // HR <= nearThreshold
  priceMoveToLiquidationPct?: number; // heuristic for SOL/USDC pairs (optional for PR8)
  hazard?: number; // PR 8.5: hazard score when using EV ranking
  ev?: number; // PR 8.5: expected value when using EV ranking
}

export interface CandidateSelectorConfig {
  nearThreshold?: number; // default 1.02
  // PR 8.5: EV-based ranking configuration (opt-in)
  useEvRanking?: boolean; // default false
  minBorrowUsd?: number; // default 10
  hazardAlpha?: number; // default 25
  evParams?: EvParams; // EV calculation parameters
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
      const distance = Math.max(0, o.healthRatio - 1);
      const urgency = o.liquidationEligible ? 1e6 : 1 / (distance + 0.001);
      const size = Math.log10(Math.max(10, o.borrowValueUsd));
      const priorityScore = urgency * size;
      const predictedLiquidatableSoon = !o.liquidationEligible && o.healthRatio <= near;

      return {
        ...o,
        distanceToLiquidation: distance,
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

    return candidates
      .map((c) => {
        // Use healthRatioRaw if available for more precise calculations
        const hr = c.healthRatioRaw ?? c.healthRatio;
        const hazard = scoreHazard(hr, alpha);
        const ev = computeEV(c.borrowValueUsd, hazard, evParams);
        return { ...c, hazard, ev };
      })
      .filter((c) => c.liquidationEligible || c.borrowValueUsd >= minBorrow)
      .sort((a, b) => (b.ev ?? 0) - (a.ev ?? 0));
  }

  // Default: sort by priorityScore
  return candidates.sort((a, b) => b.priorityScore - a.priorityScore);
}
