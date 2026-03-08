/**
 * Unit tests for PR8 candidate selector
 */

import { describe, it, expect } from "vitest";
import { selectCandidates, type ScoredObligation } from "../src/strategy/candidateSelector.js";

describe("PR8 Candidate Selector", () => {
  it("should prioritize liquidatable accounts highest", () => {
    const scored: ScoredObligation[] = [
      {
        obligationPubkey: "liq1",
        ownerPubkey: "owner1",
        healthRatio: 0.95,
        liquidationEligible: true,
        borrowValueUsd: 1000,
        collateralValueUsd: 950,
      },
      {
        obligationPubkey: "near1",
        ownerPubkey: "owner2",
        healthRatio: 1.01,
        liquidationEligible: false,
        borrowValueUsd: 5000,
        collateralValueUsd: 5050,
      },
      {
        obligationPubkey: "safe1",
        ownerPubkey: "owner3",
        healthRatio: 1.5,
        liquidationEligible: false,
        borrowValueUsd: 2000,
        collateralValueUsd: 3000,
      },
    ];

    const candidates = selectCandidates(scored);

    // Liquidatable should be first
    expect(candidates[0].obligationPubkey).toBe("liq1");
    expect(candidates[0].liquidationEligible).toBe(true);
    
    // Should have highest priority score
    expect(candidates[0].priorityScore).toBeGreaterThan(candidates[1].priorityScore);
    expect(candidates[1].priorityScore).toBeGreaterThan(candidates[2].priorityScore);
  });

  it("should calculate distance to liquidation correctly", () => {
    const scored: ScoredObligation[] = [
      {
        obligationPubkey: "test1",
        ownerPubkey: "owner1",
        healthRatio: 1.05,
        liquidationEligible: false,
        borrowValueUsd: 1000,
        collateralValueUsd: 1050,
      },
      {
        obligationPubkey: "test2",
        ownerPubkey: "owner2",
        healthRatio: 0.95,
        liquidationEligible: true,
        borrowValueUsd: 1000,
        collateralValueUsd: 950,
      },
    ];

    const candidates = selectCandidates(scored);

    // Distance for HR=1.05 should be 0.05
    const test1 = candidates.find((c) => c.obligationPubkey === "test1");
    expect(test1?.distanceToLiquidation).toBeCloseTo(0.05, 2);

    // Distance for HR=0.95 (liquidatable) should be 0.05 (absolute distance to threshold)
    const test2 = candidates.find((c) => c.obligationPubkey === "test2");
    expect(test2?.distanceToLiquidation).toBeCloseTo(0.05, 2);
  });

  it("should mark accounts near threshold as predicted liquidatable soon", () => {
    const scored: ScoredObligation[] = [
      {
        obligationPubkey: "near1",
        ownerPubkey: "owner1",
        healthRatio: 1.01,
        liquidationEligible: false,
        borrowValueUsd: 1000,
        collateralValueUsd: 1010,
      },
      {
        obligationPubkey: "safe1",
        ownerPubkey: "owner2",
        healthRatio: 1.5,
        liquidationEligible: false,
        borrowValueUsd: 1000,
        collateralValueUsd: 1500,
      },
    ];

    const candidates = selectCandidates(scored, { nearThreshold: 1.02 });

    const near = candidates.find((c) => c.obligationPubkey === "near1");
    const safe = candidates.find((c) => c.obligationPubkey === "safe1");

    expect(near?.predictedLiquidatableSoon).toBe(true);
    expect(safe?.predictedLiquidatableSoon).toBe(false);
  });

  it("should sort by priority score descending", () => {
    const scored: ScoredObligation[] = [
      {
        obligationPubkey: "safe1",
        ownerPubkey: "owner1",
        healthRatio: 1.5,
        liquidationEligible: false,
        borrowValueUsd: 100,
        collateralValueUsd: 150,
      },
      {
        obligationPubkey: "liq1",
        ownerPubkey: "owner2",
        healthRatio: 0.95,
        liquidationEligible: true,
        borrowValueUsd: 1000,
        collateralValueUsd: 950,
      },
      {
        obligationPubkey: "near1",
        ownerPubkey: "owner3",
        healthRatio: 1.01,
        liquidationEligible: false,
        borrowValueUsd: 5000,
        collateralValueUsd: 5050,
      },
    ];

    const candidates = selectCandidates(scored);

    // Should be sorted by priority score descending
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i - 1].priorityScore).toBeGreaterThanOrEqual(candidates[i].priorityScore);
    }
  });

  it("should filter out non-finite values", () => {
    const scored: ScoredObligation[] = [
      {
        obligationPubkey: "valid1",
        ownerPubkey: "owner1",
        healthRatio: 1.05,
        liquidationEligible: false,
        borrowValueUsd: 1000,
        collateralValueUsd: 1050,
      },
      {
        obligationPubkey: "invalid1",
        ownerPubkey: "owner2",
        healthRatio: NaN,
        liquidationEligible: false,
        borrowValueUsd: 1000,
        collateralValueUsd: 1050,
      },
      {
        obligationPubkey: "invalid2",
        ownerPubkey: "owner3",
        healthRatio: 1.05,
        liquidationEligible: false,
        borrowValueUsd: Infinity,
        collateralValueUsd: 1050,
      },
    ];

    const candidates = selectCandidates(scored);

    // Should only include the valid obligation
    expect(candidates.length).toBe(1);
    expect(candidates[0].obligationPubkey).toBe("valid1");
  });

  it("should handle empty input", () => {
    const candidates = selectCandidates([]);
    expect(candidates).toEqual([]);
  });

  it("should give size bonus based on borrow value", () => {
    const scored: ScoredObligation[] = [
      {
        obligationPubkey: "small1",
        ownerPubkey: "owner1",
        healthRatio: 1.01,
        liquidationEligible: false,
        borrowValueUsd: 100, // log10(100) = 2
        collateralValueUsd: 101,
      },
      {
        obligationPubkey: "large1",
        ownerPubkey: "owner2",
        healthRatio: 1.01,
        liquidationEligible: false,
        borrowValueUsd: 100000, // log10(100000) = 5
        collateralValueUsd: 101000,
      },
    ];

    const candidates = selectCandidates(scored);

    // Larger borrow should have higher priority (same HR, higher borrow)
    const small = candidates.find((c) => c.obligationPubkey === "small1");
    const large = candidates.find((c) => c.obligationPubkey === "large1");

    expect(large?.priorityScore).toBeGreaterThan(small?.priorityScore || 0);
  });

  // PR 8.5: EV-based ranking tests
  describe("EV-based ranking (opt-in)", () => {
    it("should compute hazard and EV when useEvRanking is enabled", () => {
      const scored: ScoredObligation[] = [
        {
          obligationPubkey: "test1",
          ownerPubkey: "owner1",
          healthRatio: 0.95,
          liquidationEligible: true,
          borrowValueUsd: 10000,
          collateralValueUsd: 9500,
        },
        {
          obligationPubkey: "test2",
          ownerPubkey: "owner2",
          healthRatio: 1.05,
          liquidationEligible: false,
          borrowValueUsd: 5000,
          collateralValueUsd: 5250,
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
      expect(candidates[0].hazard).toBeDefined();
      expect(candidates[0].ev).toBeDefined();
      expect(candidates[1].hazard).toBeDefined();
      expect(candidates[1].ev).toBeDefined();
    });

    it("should sort by EV descending inside the same bucket when useEvRanking is enabled", () => {
      const scored: ScoredObligation[] = [
        {
          obligationPubkey: "near_low_ev",
          ownerPubkey: "owner1",
          healthRatio: 1.01,
          liquidationEligible: false,
          borrowValueUsd: 100,
          collateralValueUsd: 101,
        },
        {
          obligationPubkey: "near_high_ev",
          ownerPubkey: "owner2",
          healthRatio: 1.015,
          liquidationEligible: false,
          borrowValueUsd: 5000,
          collateralValueUsd: 5075,
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

      // Same-bucket EV ordering should be descending
      expect(candidates[0].rankBucket).toBe("near-ready");
      expect(candidates[1].rankBucket).toBe("near-ready");
      expect(candidates[0].obligationPubkey).toBe("near_high_ev");
      expect(candidates[0].ev).toBeGreaterThan(candidates[1].ev || 0);
    });

    it("near-ready candidate can rank above far-horizon candidate even with lower EV", () => {
      const scored: ScoredObligation[] = [
        {
          obligationPubkey: "near_lower_ev",
          ownerPubkey: "owner1",
          healthRatio: 1.0083,
          liquidationEligible: false,
          borrowValueUsd: 100,
          collateralValueUsd: 100.83,
        },
        {
          obligationPubkey: "far_higher_ev",
          ownerPubkey: "owner2",
          healthRatio: 1.1186,
          liquidationEligible: false,
          borrowValueUsd: 1_000_000,
          collateralValueUsd: 1_118_600,
        },
      ];

      const candidates = selectCandidates(scored, {
        useEvRanking: true,
        nearThreshold: 1.02,
        minBorrowUsd: 10,
        hazardAlpha: 25,
        evParams: {
          closeFactor: 0.5,
          liquidationBonusPct: 0.05,
          flashloanFeePct: 0.002,
          fixedGasUsd: 0.5,
        },
      });

      expect(candidates[0].obligationPubkey).toBe("near_lower_ev");
      expect(candidates[0].rankBucket).toBe("near-ready");
      expect(candidates[1].ev).toBeGreaterThan(candidates[0].ev || 0);
    });

    it("liquidatable candidates always rank above non-liquidatable candidates", () => {
      const scored: ScoredObligation[] = [
        {
          obligationPubkey: "non_liq_big_ev",
          ownerPubkey: "owner1",
          healthRatio: 1.2,
          liquidationEligible: false,
          borrowValueUsd: 500_000,
          collateralValueUsd: 600_000,
        },
        {
          obligationPubkey: "liq_small_ev",
          ownerPubkey: "owner2",
          healthRatio: 0.99,
          liquidationEligible: true,
          borrowValueUsd: 100,
          collateralValueUsd: 99,
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

      expect(candidates[0].obligationPubkey).toBe("liq_small_ev");
      expect(candidates[0].rankBucket).toBe("liquidatable");
      expect(candidates[1].rankBucket).not.toBe("liquidatable");
    });

    it("legacy-global TTL candidates rank behind pair-aware candidates in EV mode", () => {
      const scored: ScoredObligation[] = [
        {
          obligationPubkey: "pair_aware_far",
          ownerPubkey: "owner1",
          healthRatio: 1.5,
          liquidationEligible: false,
          borrowValueUsd: 1000,
          collateralValueUsd: 1500,
          ttlContext: {
            deposits: [{ mint: "volatile-a", usdRaw: 800, usdWeighted: 640, shareOfWeightedSide: 1, assetClass: "volatile" }],
            borrows: [{ mint: "volatile-b", usdRaw: 600, usdWeighted: 600, shareOfWeightedSide: 1, assetClass: "volatile" }],
            totalCollateralUsdAdj: 640,
            totalBorrowUsdAdj: 600,
            totalCollateralUsdRaw: 800,
            totalBorrowUsdRaw: 600,
            activeDepositCount: 1,
            activeBorrowCount: 1,
          },
        },
        {
          obligationPubkey: "legacy_far",
          ownerPubkey: "owner2",
          healthRatio: 1.5,
          liquidationEligible: false,
          borrowValueUsd: 5000,
          collateralValueUsd: 7500,
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

      const pairAwareIdx = candidates.findIndex((c) => c.obligationPubkey === "pair_aware_far");
      const legacyIdx = candidates.findIndex((c) => c.obligationPubkey === "legacy_far");
      expect(pairAwareIdx).toBeGreaterThanOrEqual(0);
      expect(legacyIdx).toBeGreaterThanOrEqual(0);
      expect(pairAwareIdx).toBeLessThan(legacyIdx);
    });

    it("should filter by minBorrowUsd unless liquidatable in EV mode", () => {
      const scored: ScoredObligation[] = [
        {
          obligationPubkey: "below_min",
          ownerPubkey: "owner1",
          healthRatio: 1.05,
          liquidationEligible: false,
          borrowValueUsd: 5, // Below minBorrowUsd
          collateralValueUsd: 5.25,
        },
        {
          obligationPubkey: "below_min_liq",
          ownerPubkey: "owner2",
          healthRatio: 0.95,
          liquidationEligible: true,
          borrowValueUsd: 5, // Below minBorrowUsd but liquidatable
          collateralValueUsd: 4.75,
        },
        {
          obligationPubkey: "above_min",
          ownerPubkey: "owner3",
          healthRatio: 1.05,
          liquidationEligible: false,
          borrowValueUsd: 100,
          collateralValueUsd: 105,
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

      // Should include below_min_liq (liquidatable) and above_min
      expect(candidates.length).toBe(2);
      expect(candidates.map((c) => c.obligationPubkey)).toContain("below_min_liq");
      expect(candidates.map((c) => c.obligationPubkey)).toContain("above_min");
      expect(candidates.map((c) => c.obligationPubkey)).not.toContain("below_min");
    });

    it("should use healthRatioRaw when available in EV mode", () => {
      const scored: ScoredObligation[] = [
        {
          obligationPubkey: "with_raw",
          ownerPubkey: "owner1",
          healthRatio: 2.0, // Clamped
          healthRatioRaw: 10.5, // Unclamped
          liquidationEligible: false,
          borrowValueUsd: 1000,
          collateralValueUsd: 10500,
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

      expect(candidates.length).toBe(1);
      // Hazard computed from healthRatioRaw (10.5) should be much lower than from clamped (2.0)
      // With alpha=25 and margin=9.5: hazard = 1/(1+25*9.5) = 1/238.5 ≈ 0.0042
      expect(candidates[0].hazard).toBeLessThan(0.01);
    });

    it("should maintain default behavior when useEvRanking is false", () => {
      const scored: ScoredObligation[] = [
        {
          obligationPubkey: "liq1",
          ownerPubkey: "owner1",
          healthRatio: 0.95,
          liquidationEligible: true,
          borrowValueUsd: 1000,
          collateralValueUsd: 950,
        },
        {
          obligationPubkey: "safe1",
          ownerPubkey: "owner2",
          healthRatio: 1.5,
          liquidationEligible: false,
          borrowValueUsd: 10000,
          collateralValueUsd: 15000,
        },
      ];

      const candidates = selectCandidates(scored, { useEvRanking: false });

      // Should use default priority scoring
      expect(candidates[0].obligationPubkey).toBe("liq1");
      expect(candidates[0].hazard).toBeUndefined();
      expect(candidates[0].ev).toBeUndefined();
      expect(candidates[0].priorityScore).toBeGreaterThan(candidates[1].priorityScore);
    });
  });
});
