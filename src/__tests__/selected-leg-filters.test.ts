import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { ScoredObligation } from "../strategy/candidateSelector.js";
import { filterCandidatesBySelectedLegUsd } from "../strategy/selectedLegFilters.js";

function makeCandidate(
  obligationPubkey: string,
  selectedBorrowUsdRaw?: number,
  selectedCollateralUsdRaw?: number
): ScoredObligation {
  return {
    obligationPubkey,
    ownerPubkey: PublicKey.unique().toBase58(),
    healthRatio: 1.01,
    liquidationEligible: false,
    borrowValueUsd: 500,
    collateralValueUsd: 600,
    evContext:
      selectedBorrowUsdRaw === undefined || selectedCollateralUsdRaw === undefined
        ? undefined
        : {
            selectedBorrowReservePubkey: PublicKey.unique().toBase58(),
            selectedCollateralReservePubkey: PublicKey.unique().toBase58(),
            selectedBorrowMint: PublicKey.unique().toBase58(),
            selectedCollateralMint: PublicKey.unique().toBase58(),
            selectedBorrowUsdRaw,
            selectedBorrowUsdWeighted: selectedBorrowUsdRaw,
            selectedCollateralUsdRaw,
            selectedCollateralUsdWeighted: selectedCollateralUsdRaw,
            totalBorrowUsdRaw: 500,
            totalBorrowUsdAdj: 500,
            totalCollateralUsdRaw: 600,
            totalCollateralUsdAdj: 600,
            minLiquidationBonusPct: null,
            maxLiquidationBonusPct: null,
            protocolLiquidationFeePct: null,
            swapRequired: false,
          },
  };
}

describe("filterCandidatesBySelectedLegUsd", () => {
  it("rejects missing evContext and increments missingEvContext", () => {
    const result = filterCandidatesBySelectedLegUsd(
      [makeCandidate("missing")],
      { minSelectedRepayUsd: 100, minSelectedCollateralUsd: 100 }
    );

    expect(result.passed).toHaveLength(0);
    expect(result.stats.missingEvContext).toBe(1);
  });

  it("rejects candidate when selected repay leg is below threshold", () => {
    const result = filterCandidatesBySelectedLegUsd(
      [makeCandidate("repay-too-small", 50, 200)],
      { minSelectedRepayUsd: 100, minSelectedCollateralUsd: 100 }
    );

    expect(result.passed).toHaveLength(0);
    expect(result.stats.repayTooSmall).toBe(1);
    expect(result.stats.collateralTooSmall).toBe(0);
  });

  it("rejects candidate when selected collateral leg is below threshold", () => {
    const result = filterCandidatesBySelectedLegUsd(
      [makeCandidate("collateral-too-small", 200, 50)],
      { minSelectedRepayUsd: 100, minSelectedCollateralUsd: 100 }
    );

    expect(result.passed).toHaveLength(0);
    expect(result.stats.repayTooSmall).toBe(0);
    expect(result.stats.collateralTooSmall).toBe(1);
  });

  it("passes candidate when both selected legs are above thresholds", () => {
    const result = filterCandidatesBySelectedLegUsd(
      [makeCandidate("pass", 120, 150)],
      { minSelectedRepayUsd: 100, minSelectedCollateralUsd: 100 }
    );

    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]?.obligationPubkey).toBe("pass");
  });

  it("tracks stats counters correctly across mixed inputs", () => {
    const candidates = [
      makeCandidate("missing"),
      makeCandidate("repay-small", 20, 200),
      makeCandidate("collateral-small", 200, 20),
      makeCandidate("both-small", 20, 20),
      makeCandidate("pass", 200, 200),
    ];

    const result = filterCandidatesBySelectedLegUsd(candidates, {
      minSelectedRepayUsd: 100,
      minSelectedCollateralUsd: 100,
    });

    expect(result.stats).toEqual({
      totalInput: 5,
      missingEvContext: 1,
      repayTooSmall: 2,
      collateralTooSmall: 2,
      passed: 1,
    });
    expect(result.passed.map((c) => c.obligationPubkey)).toEqual(["pass"]);
  });
});
