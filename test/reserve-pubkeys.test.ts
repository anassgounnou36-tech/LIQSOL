/**
 * Unit tests for reserve pubkey extraction and validation
 */

import { describe, it, expect } from "vitest";
import { selectCandidates, type ScoredObligation } from "../src/strategy/candidateSelector.js";

describe("Reserve Pubkey Extraction and Validation", () => {
  it("should pass through reserve pubkeys from scored obligations", () => {
    const scored: ScoredObligation[] = [
      {
        obligationPubkey: "ObligationXYZ",
        ownerPubkey: "OwnerABC",
        healthRatio: 1.05,
        liquidationEligible: false,
        borrowValueUsd: 1000,
        collateralValueUsd: 1050,
        repayReservePubkey: "RepayReserve123",
        collateralReservePubkey: "CollateralReserve456",
        primaryBorrowMint: "USDC",
        primaryCollateralMint: "SOL",
      },
    ];

    const candidates = selectCandidates(scored);

    expect(candidates.length).toBe(1);
    expect(candidates[0].repayReservePubkey).toBe("RepayReserve123");
    expect(candidates[0].collateralReservePubkey).toBe("CollateralReserve456");
    expect(candidates[0].primaryBorrowMint).toBe("USDC");
    expect(candidates[0].primaryCollateralMint).toBe("SOL");
  });

  it("should handle candidates without reserve pubkeys", () => {
    const scored: ScoredObligation[] = [
      {
        obligationPubkey: "OldObligation",
        ownerPubkey: "OwnerDEF",
        healthRatio: 1.02,
        liquidationEligible: false,
        borrowValueUsd: 500,
        collateralValueUsd: 510,
        // No reserve pubkeys (legacy plan)
      },
    ];

    const candidates = selectCandidates(scored);

    expect(candidates.length).toBe(1);
    expect(candidates[0].repayReservePubkey).toBeUndefined();
    expect(candidates[0].collateralReservePubkey).toBeUndefined();
  });

  it("should maintain reserve pubkeys through EV ranking", () => {
    const scored: ScoredObligation[] = [
      {
        obligationPubkey: "Obl1",
        ownerPubkey: "Owner1",
        healthRatio: 0.95,
        liquidationEligible: true,
        borrowValueUsd: 10000,
        collateralValueUsd: 9500,
        repayReservePubkey: "RepayRes1",
        collateralReservePubkey: "CollateralRes1",
      },
      {
        obligationPubkey: "Obl2",
        ownerPubkey: "Owner2",
        healthRatio: 1.05,
        liquidationEligible: false,
        borrowValueUsd: 5000,
        collateralValueUsd: 5250,
        repayReservePubkey: "RepayRes2",
        collateralReservePubkey: "CollateralRes2",
      },
    ];

    const candidates = selectCandidates(scored, {
      useEvRanking: true,
      minBorrowUsd: 10,
      hazardAlpha: 25,
      evParams: {
        closeFactor: 0.5,
        liquidationBonusPct: 0.05,
        flashloanFeePct: 0.002,
        fixedGasUsd: 0.5,
      },
    });

    expect(candidates.length).toBe(2);
    
    // Check that reserve pubkeys are preserved through EV ranking
    const obl1 = candidates.find(c => c.obligationPubkey === "Obl1");
    const obl2 = candidates.find(c => c.obligationPubkey === "Obl2");
    
    expect(obl1?.repayReservePubkey).toBe("RepayRes1");
    expect(obl1?.collateralReservePubkey).toBe("CollateralRes1");
    expect(obl2?.repayReservePubkey).toBe("RepayRes2");
    expect(obl2?.collateralReservePubkey).toBe("CollateralRes2");
  });

  it("should prioritize liquidatable candidates with reserve pubkeys", () => {
    const scored: ScoredObligation[] = [
      {
        obligationPubkey: "SafeObl",
        ownerPubkey: "Owner1",
        healthRatio: 1.5,
        liquidationEligible: false,
        borrowValueUsd: 100,
        collateralValueUsd: 150,
        repayReservePubkey: "SafeRepay",
        collateralReservePubkey: "SafeCollateral",
      },
      {
        obligationPubkey: "LiquidatableObl",
        ownerPubkey: "Owner2",
        healthRatio: 0.95,
        liquidationEligible: true,
        borrowValueUsd: 1000,
        collateralValueUsd: 950,
        repayReservePubkey: "LiqRepay",
        collateralReservePubkey: "LiqCollateral",
      },
    ];

    const candidates = selectCandidates(scored);

    // Liquidatable should be first
    expect(candidates[0].obligationPubkey).toBe("LiquidatableObl");
    expect(candidates[0].repayReservePubkey).toBe("LiqRepay");
    expect(candidates[0].collateralReservePubkey).toBe("LiqCollateral");
  });
});
