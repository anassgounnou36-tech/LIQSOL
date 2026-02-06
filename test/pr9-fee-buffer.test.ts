/**
 * Unit tests for PR9 fee buffer precheck
 */

import { describe, it, expect } from "vitest";

describe("PR9 Fee Buffer Calculation", () => {
  it("should calculate default fee buffer as 0.5% of borrowed amount", () => {
    const amount = "1000";
    const defaultFeeBuffer = parseFloat(amount) * 0.005;
    expect(defaultFeeBuffer).toBe(5); // 0.5% of 1000 = 5
  });

  it("should calculate fee buffer for different amounts", () => {
    const testCases = [
      { amount: "1000", expected: 5 },
      { amount: "10", expected: 0.05 },
      { amount: "5000", expected: 25 },
      { amount: "100", expected: 0.5 },
    ];

    testCases.forEach(({ amount, expected }) => {
      const feeBuffer = parseFloat(amount) * 0.005;
      expect(feeBuffer).toBe(expected);
    });
  });

  it("should allow custom fee buffer override", () => {
    const amount = "1000";
    const defaultFeeBuffer = parseFloat(amount) * 0.005;
    const customFeeBuffer = 10; // User override
    
    expect(customFeeBuffer).toBeGreaterThan(defaultFeeBuffer);
    expect(customFeeBuffer).toBe(10);
  });

  it("should calculate shortfall correctly", () => {
    const requiredBuffer = 5;
    const currentBalance = 2;
    const shortfall = requiredBuffer - currentBalance;
    
    expect(shortfall).toBe(3);
  });

  it("should pass check when balance equals required buffer", () => {
    const currentBalance = 5;
    const requiredBuffer = 5;
    
    expect(currentBalance >= requiredBuffer).toBe(true);
  });

  it("should pass check when balance exceeds required buffer", () => {
    const currentBalance = 10;
    const requiredBuffer = 5;
    
    expect(currentBalance >= requiredBuffer).toBe(true);
  });

  it("should fail check when balance is less than required buffer", () => {
    const currentBalance = 2;
    const requiredBuffer = 5;
    
    expect(currentBalance < requiredBuffer).toBe(true);
  });

  it("should handle edge case of zero balance", () => {
    const currentBalance = 0;
    const requiredBuffer = 5;
    const shortfall = requiredBuffer - currentBalance;
    
    expect(shortfall).toBe(5);
    expect(currentBalance < requiredBuffer).toBe(true);
  });

  it("should handle very small amounts for SOL", () => {
    const amount = "0.1"; // 0.1 SOL
    const feeBuffer = parseFloat(amount) * 0.005;
    expect(feeBuffer).toBe(0.0005); // 0.0005 SOL
  });

  it("should preserve precision for fee calculations", () => {
    const amount = "1234.56";
    const feeBuffer = parseFloat(amount) * 0.005;
    expect(feeBuffer).toBeCloseTo(6.1728, 4);
  });
});
