/**
 * Unit tests for enhanced toBigInt utility to handle SF/BSF fields
 */

import { describe, it, expect } from "vitest";
import { toBigInt } from "../src/utils/bn.js";

describe("toBigInt - Enhanced SF/BSF Field Handling", () => {
  it("should convert bigint values directly", () => {
    expect(toBigInt(123n)).toBe(123n);
    expect(toBigInt(0n)).toBe(0n);
    expect(toBigInt(-456n)).toBe(-456n);
  });

  it("should convert integer numbers", () => {
    expect(toBigInt(123)).toBe(123n);
    expect(toBigInt(0)).toBe(0n);
    expect(toBigInt(-456)).toBe(-456n);
  });

  it("should reject decimal numbers", () => {
    expect(() => toBigInt(123.45)).toThrow("decimal numbers not supported");
    expect(() => toBigInt(0.1)).toThrow("decimal numbers not supported");
  });

  it("should reject non-finite numbers", () => {
    expect(() => toBigInt(NaN)).toThrow("non-finite number");
    expect(() => toBigInt(Infinity)).toThrow("non-finite number");
    expect(() => toBigInt(-Infinity)).toThrow("non-finite number");
  });

  it("should convert integer strings", () => {
    expect(toBigInt("123")).toBe(123n);
    expect(toBigInt("0")).toBe(0n);
    expect(toBigInt("-456")).toBe(-456n);
    expect(toBigInt("  789  ")).toBe(789n); // with whitespace
  });

  it("should reject scientific notation strings", () => {
    expect(() => toBigInt("1e10")).toThrow("invalid integer string");
    expect(() => toBigInt("1.23e5")).toThrow("invalid integer string");
  });

  it("should reject non-integer strings", () => {
    expect(() => toBigInt("123.45")).toThrow("invalid integer string");
    expect(() => toBigInt("abc")).toThrow("invalid integer string");
  });

  it("should handle objects with bsf field (BigScaledFraction)", () => {
    const bsfObj = { bsf: "1000000000000000000" }; // 1e18
    expect(toBigInt(bsfObj)).toBe(1000000000000000000n);
  });

  it("should handle nested bsf objects", () => {
    const nestedBsf = { bsf: { bsf: "5000000000000000000" } };
    expect(toBigInt(nestedBsf)).toBe(5000000000000000000n);
  });

  it("should handle objects with raw field", () => {
    const rawObj = { raw: "2000000000000000000" };
    expect(toBigInt(rawObj)).toBe(2000000000000000000n);
  });

  it("should handle objects with value field (non-array)", () => {
    const valueObj = { value: "3000000000000000000" };
    expect(toBigInt(valueObj)).toBe(3000000000000000000n);
  });

  it("should handle BN-like objects with toString()", () => {
    const bnLike = {
      toString: () => "42",
    };
    expect(toBigInt(bnLike)).toBe(42n);
  });

  it("should reject BN-like objects with invalid toString() output", () => {
    const invalidBnLike = {
      toString: () => "123.45",
    };
    expect(() => toBigInt(invalidBnLike)).toThrow("unsupported type");
  });

  it("should handle BigFractionBytes with value array", () => {
    // BigFractionBytes: { value: [u64; 4] }
    // This tests the array path (will delegate to bigFractionBytesToBigInt)
    const bfb = { value: [100n, 0n, 0n, 0n] };
    expect(toBigInt(bfb)).toBe(100n);
  });

  it("should provide detailed error messages", () => {
    try {
      toBigInt("1.23e5");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("invalid integer string");
      expect((err as Error).message).toContain("1.23e5");
    }
  });

  it("should handle priority of object field resolution (bsf > raw > value)", () => {
    // bsf takes priority
    const objWithMultipleFields = {
      bsf: "100",
      raw: "200",
      value: "300",
    };
    expect(toBigInt(objWithMultipleFields)).toBe(100n);

    // raw takes priority when bsf is missing
    const objWithRawAndValue = {
      raw: "200",
      value: "300",
    };
    expect(toBigInt(objWithRawAndValue)).toBe(200n);
  });
});
