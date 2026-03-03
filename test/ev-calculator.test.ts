import { describe, expect, it } from "vitest";
import { computeEV, computeEVBreakdown } from "../src/predict/evCalculator.js";

describe("EV calculator", () => {
  it("charges variable fees on repay value", () => {
    const params = {
      closeFactor: 0.5,
      liquidationBonusPct: 0.05,
      flashloanFeePct: 0.002,
      slippageBufferPct: 0.003,
      fixedGasUsd: 0.5,
    };

    const breakdown = computeEVBreakdown(1000, 1, params);
    expect(breakdown.repayValueUsd).toBeCloseTo(500, 8);
    expect(breakdown.profit).toBeCloseTo(25, 8);
    expect(breakdown.variableFees).toBeCloseTo(2.5, 8);
    expect(breakdown.cost).toBeCloseTo(3, 8);
    expect(computeEV(1000, 1, params)).toBeCloseTo(22, 8);
  });
});
