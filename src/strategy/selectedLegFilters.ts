import type { ScoredObligation } from './candidateSelector.js';

export interface SelectedLegFilterStats {
  totalInput: number;
  missingEvContext: number;
  repayTooSmall: number;
  collateralTooSmall: number;
  passed: number;
}

export interface SelectedLegThresholds {
  minSelectedRepayUsd: number;
  minSelectedCollateralUsd: number;
}

export function filterCandidatesBySelectedLegUsd(
  candidates: ScoredObligation[],
  thresholds: SelectedLegThresholds
): {
  passed: ScoredObligation[];
  stats: SelectedLegFilterStats;
} {
  const passed: ScoredObligation[] = [];
  const stats: SelectedLegFilterStats = {
    totalInput: candidates.length,
    missingEvContext: 0,
    repayTooSmall: 0,
    collateralTooSmall: 0,
    passed: 0,
  };

  for (const candidate of candidates) {
    if (!candidate.evContext) {
      stats.missingEvContext++;
      continue;
    }

    const repayPass = candidate.evContext.selectedBorrowUsdRaw >= thresholds.minSelectedRepayUsd;
    const collateralPass =
      candidate.evContext.selectedCollateralUsdRaw >= thresholds.minSelectedCollateralUsd;

    if (!repayPass) stats.repayTooSmall++;
    if (!collateralPass) stats.collateralTooSmall++;

    if (repayPass && collateralPass) {
      passed.push(candidate);
      stats.passed++;
    }
  }

  return { passed, stats };
}
