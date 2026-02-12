/**
 * Test to verify the BN parsing fix in liquidation builder
 */

import { describe, it, expect } from "vitest";
import { toBigInt } from "../src/utils/bn.js";

describe("Liquidation Builder - BN Parsing Fix", () => {
  it("should handle Kamino SF (scaled fraction) fields", () => {
    // Simulate borrowedAmountSf from Kamino obligation
    const borrowedAmountSf = {
      bsf: "1500000000000000000000", // 1500 * 1e18 (scaled)
    };
    
    const result = toBigInt(borrowedAmountSf);
    expect(result).toBe(1500000000000000000000n);
  });

  it("should handle Kamino BSF (big scaled fraction) fields from reserve", () => {
    // Simulate cumulativeBorrowRateBsf from Kamino reserve
    const cumulativeBorrowRateBsf = {
      value: [1050000000000000000n, 0n, 0n, 0n], // BigFractionBytes array
    };
    
    const result = toBigInt(cumulativeBorrowRateBsf);
    expect(result).toBe(1050000000000000000n); // 1.05 * 1e18
  });

  it("should calculate repay amount with proper bigint math", () => {
    // Simulate the calculation flow in liquidationBuilder.ts
    const borrowedAmountSf = {
      bsf: "2000000000000000000000", // 2000 * 1e18
    };
    const cumulativeBorrowRateBsf = {
      value: [1100000000000000000n, 0n, 0n, 0n], // 1.1 * 1e18
    };
    
    const borrowedSf = toBigInt(borrowedAmountSf);
    const cumRateBsf = toBigInt(cumulativeBorrowRateBsf);
    
    expect(borrowedSf).toBe(2000000000000000000000n);
    expect(cumRateBsf).toBe(1100000000000000000n);
    
    // Calculate actual borrow amount: borrowedSf * cumRate / 1e18 / 1e18
    const SCALE_1E18 = 10n ** 18n;
    const borrowAmountBase = (borrowedSf * cumRateBsf) / SCALE_1E18 / SCALE_1E18;
    
    expect(borrowAmountBase).toBe(2200n); // 2000 * 1.1 = 2200
    
    // Apply 50% close factor
    const closeFactorPermille = 500n;
    const liquidityAmount = (borrowAmountBase * closeFactorPermille) / 1000n;
    
    expect(liquidityAmount).toBe(1100n); // 2200 * 0.5 = 1100
  });

  it("should reject invalid formats that would cause 'Invalid character' error", () => {
    // These are the types of values that caused the original bug
    expect(() => toBigInt("1.5e18")).toThrow("invalid integer string");
    expect(() => toBigInt("1.5")).toThrow("invalid integer string");
    expect(() => toBigInt(1.5)).toThrow("decimal numbers not supported");
  });

  it("should handle toString() calls on SF/BSF objects safely", () => {
    // When .toString() is called on an object with nested bsf
    const sfObj = {
      bsf: "3000000000000000000000",
      toString: () => "3000000000000000000000", // This would work
    };
    
    const result = toBigInt(sfObj);
    expect(result).toBe(3000000000000000000000n);
  });

  it("should handle raw field from Kamino types", () => {
    const rawObj = {
      raw: "4000000000000000000000",
    };
    
    const result = toBigInt(rawObj);
    expect(result).toBe(4000000000000000000000n);
  });

  it("should calculate liquidation with realistic values", () => {
    // Real-world example: $10,000 borrowed at 1.05x cumulative rate
    const borrowedAmountSf = "10000000000000000000000"; // 10000 * 1e18
    const cumulativeBorrowRateBsf = "1050000000000000000"; // 1.05 * 1e18
    
    const borrowedSf = toBigInt(borrowedAmountSf);
    const cumRateBsf = toBigInt(cumulativeBorrowRateBsf);
    
    const SCALE_1E18 = 10n ** 18n;
    const borrowAmountBase = (borrowedSf * cumRateBsf) / SCALE_1E18 / SCALE_1E18;
    
    // 10000 * 1.05 = 10500 tokens in base units
    expect(borrowAmountBase).toBe(10500n);
    
    // Apply 50% close factor for liquidation
    const closeFactorPermille = 500n;
    const liquidityAmount = (borrowAmountBase * closeFactorPermille) / 1000n;
    
    // Can liquidate 5250 tokens (50% of 10500)
    expect(liquidityAmount).toBe(5250n);
  });
});
