/**
 * Candidate Selector Module
 * 
 * Takes scored obligations and ranks them by priority for liquidation monitoring.
 * Exposes distance-to-liquidation metrics and simple heuristics for targeting.
 */

export interface ScoredObligation {
  obligationPubkey: string;
  ownerPubkey: string;
  healthRatio: number; // e.g., 0.95 liquidatable, 1.02 near threshold
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
}

export interface CandidateSelectorConfig {
  nearThreshold?: number; // default 1.02
}

/**
 * Select and rank candidates from scored obligations.
 * 
 * Priority scoring logic:
 * - Liquidatable accounts get massive priority boost (10,000)
 * - Higher priority for accounts closer to liquidation threshold (1 / (distance + 0.001))
 * - Size bonus based on borrow value (log10 of USD value)
 * - Results sorted descending by priority score
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

  const candidates: Candidate[] = scored
    .filter((o) => Number.isFinite(o.healthRatio) && Number.isFinite(o.borrowValueUsd))
    .map((o) => {
      const distance = Math.max(0, o.healthRatio - 1);
      const base = (o.liquidationEligible ? 10_000 : 0) + 1 / (distance + 0.001);
      const size = Math.log10(Math.max(1, o.borrowValueUsd));
      const priorityScore = base + size;
      const predictedLiquidatableSoon = !o.liquidationEligible && o.healthRatio <= near;

      return {
        ...o,
        distanceToLiquidation: distance,
        priorityScore,
        predictedLiquidatableSoon,
        // priceMoveToLiquidationPct can be populated downstream when mint info is available (optional for PR8)
      };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore);

  return candidates;
}
