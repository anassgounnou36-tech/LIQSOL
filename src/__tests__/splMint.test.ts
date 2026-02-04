import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import { parseSplMintDecimals } from "../utils/splMint.js";

describe("SPL Mint Decimals Parser", () => {
  it("should parse decimals from valid mint account data", () => {
    // Create a buffer with at least 45 bytes
    // Byte 44 should contain the decimals value
    const buffer = Buffer.alloc(82); // Full mint account size
    buffer[44] = 6; // USDC has 6 decimals
    
    const result = parseSplMintDecimals(buffer);
    expect(result).toBe(6);
  });

  it("should parse decimals with value 0", () => {
    const buffer = Buffer.alloc(82);
    buffer[44] = 0; // 0 is a valid decimals value
    
    const result = parseSplMintDecimals(buffer);
    expect(result).toBe(0);
  });

  it("should parse decimals with value 9 (SOL)", () => {
    const buffer = Buffer.alloc(82);
    buffer[44] = 9; // SOL has 9 decimals
    
    const result = parseSplMintDecimals(buffer);
    expect(result).toBe(9);
  });

  it("should return null for buffer shorter than 45 bytes", () => {
    const buffer = Buffer.alloc(44); // Too short
    
    const result = parseSplMintDecimals(buffer);
    expect(result).toBeNull();
  });

  it("should return null for null buffer", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = parseSplMintDecimals(null as any);
    expect(result).toBeNull();
  });

  it("should return null for undefined buffer", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = parseSplMintDecimals(undefined as any);
    expect(result).toBeNull();
  });

  it("should handle maximum decimals value (255)", () => {
    const buffer = Buffer.alloc(82);
    buffer[44] = 255;
    
    const result = parseSplMintDecimals(buffer);
    expect(result).toBe(255);
  });

  it("should parse decimals from exactly 45 bytes", () => {
    const buffer = Buffer.alloc(45); // Minimum valid size
    buffer[44] = 8;
    
    const result = parseSplMintDecimals(buffer);
    expect(result).toBe(8);
  });
});
