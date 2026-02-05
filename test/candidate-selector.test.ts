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

    // Distance for HR=0.95 (liquidatable) should be 0
    const test2 = candidates.find((c) => c.obligationPubkey === "test2");
    expect(test2?.distanceToLiquidation).toBe(0);
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
});
