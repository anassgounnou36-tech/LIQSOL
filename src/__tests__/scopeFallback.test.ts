import { describe, it, expect, vi, beforeEach } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { loadOracles } from "../cache/oracleCache.js";
import type { ReserveCache } from "../cache/reserveCache.js";

// Mock the dependencies
vi.mock("../observability/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the Scope SDK OraclePrices.decode
vi.mock("@kamino-finance/scope-sdk/dist/@codegen/scope/accounts/index.js", () => ({
  OraclePrices: {
    decode: vi.fn(),
  },
}));

import { OraclePrices } from "@kamino-finance/scope-sdk/dist/@codegen/scope/accounts/index.js";
import { scopeMintChainMap } from "../cache/reserveCache.js";

describe("Scope Fallback Chain Search Tests", () => {
  let mockConnection: Connection;
  const SCOPE_PROGRAM_ID = new PublicKey("HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ");

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnection = {} as Connection;
    // Clear the scopeMintChainMap before each test
    scopeMintChainMap.clear();
  });

  /**
   * Helper to create mock Scope price data at a specific chain index
   */
  function createMockScopePriceArray(validChains: Map<number, { price: string; exp: number; timestamp: number }>): any[] {
    // Handle empty map case
    if (validChains.size === 0) {
      return new Array(512).fill(null);
    }
    
    const maxChain = Math.max(...Array.from(validChains.keys()));
    const prices = new Array(Math.max(512, maxChain + 1)).fill(null);
    
    for (const [chain, { price, exp, timestamp }] of validChains.entries()) {
      prices[chain] = {
        price: {
          value: { toString: () => price },
          exp: { toString: () => exp.toString() },
        },
        unixTimestamp: { toString: () => timestamp.toString() },
      };
    }
    
    return prices;
  }

  describe("Fallback chain search when configured chains fail", () => {
    it("should use primary fallback chain 0 when configured chain fails", async () => {
      const mint1 = "So11111111111111111111111111111111111111112"; // SOL, not a stablecoin
      const oraclePubkey = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
      
      const reserveCache: ReserveCache = new Map([
        [
          mint1,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            cumulativeBorrowRateBsfRaw: 1000000000000000000n,
            collateralMint: "mock-collateral-mint",
            collateralExchangeRateUi: 1.0,
            scopePriceChain: [100], // Invalid chain that doesn't exist in oracle
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oraclePubkey],
          },
        ],
      ]);

      // Mock Scope data with price at chain 0 (fallback) but not at chain 100
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [0, { price: "100000000", exp: 8, timestamp: currentTimestamp }],
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({
        prices: mockPrices,
      } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should have found price via fallback chain 0
      expect(cache.has(mint1)).toBe(true);
      const price = cache.get(mint1);
      expect(price).toBeDefined();
      expect(price!.price).toBe(100000000n);
      expect(price!.oracleType).toBe("scope");
    });

    it("should use primary fallback chain 3 when chain 0 also fails", async () => {
      const mint1 = "So11111111111111111111111111111111111111112"; // SOL, not a stablecoin
      const oraclePubkey = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
      
      const reserveCache: ReserveCache = new Map([
        [
          mint1,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            cumulativeBorrowRateBsfRaw: 1000000000000000000n,
            collateralMint: "mock-collateral-mint",
            collateralExchangeRateUi: 1.0,
            scopePriceChain: [100], // Invalid chain
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oraclePubkey],
          },
        ],
      ]);

      // Mock Scope data with price only at chain 3
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [3, { price: "200000000", exp: 8, timestamp: currentTimestamp }],
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({
        prices: mockPrices,
      } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should have found price via fallback chain 3
      expect(cache.has(mint1)).toBe(true);
      const price = cache.get(mint1);
      expect(price).toBeDefined();
      expect(price!.price).toBe(200000000n);
    });

    it("should scan curated fallback candidates when primary fallbacks fail", async () => {
      const mint1 = "So11111111111111111111111111111111111111112"; // SOL, not a stablecoin
      const oraclePubkey = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
      
      const reserveCache: ReserveCache = new Map([
        [
          mint1,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            cumulativeBorrowRateBsfRaw: 1000000000000000000n,
            collateralMint: "mock-collateral-mint",
            collateralExchangeRateUi: 1.0,
            scopePriceChain: [100], // Invalid chain
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oraclePubkey],
          },
        ],
      ]);

      // Mock Scope data with price only at chain 118 (in curated candidates list)
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [118, { price: "300000000", exp: 8, timestamp: currentTimestamp }],
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({
        prices: mockPrices,
      } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should have found price via curated fallback candidate 118
      expect(cache.has(mint1)).toBe(true);
      const price = cache.get(mint1);
      expect(price).toBeDefined();
      expect(price!.price).toBe(300000000n);
    });

    it("should return null when no valid price found after exhaustive search", async () => {
      const mint1 = "So11111111111111111111111111111111111111112"; // SOL, not a stablecoin
      const oraclePubkey = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
      
      const reserveCache: ReserveCache = new Map([
        [
          mint1,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            cumulativeBorrowRateBsfRaw: 1000000000000000000n,
            collateralMint: "mock-collateral-mint",
            collateralExchangeRateUi: 1.0,
            scopePriceChain: [100], // Invalid chain
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oraclePubkey],
          },
        ],
      ]);

      // Mock Scope data with no valid prices anywhere
      vi.mocked(OraclePrices.decode).mockReturnValue({
        prices: new Array(512).fill(null),
      } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should not have price for mint (no valid chains found)
      expect(cache.has(mint1)).toBe(false);
    });
  });

  describe("Configured chains should take precedence over fallback", () => {
    it("should use configured chain when it has valid price", async () => {
      const mint1 = "So11111111111111111111111111111111111111112"; // SOL, not a stablecoin
      const oraclePubkey = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
      
      const reserveCache: ReserveCache = new Map([
        [
          mint1,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            cumulativeBorrowRateBsfRaw: 1000000000000000000n,
            collateralMint: "mock-collateral-mint",
            collateralExchangeRateUi: 1.0,
            scopePriceChain: [50], // Valid configured chain
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oraclePubkey],
          },
        ],
      ]);
      
      // Populate the scopeMintChainMap with the configured chain
      scopeMintChainMap.set(mint1, [50]);

      // Mock Scope data with prices at both configured chain 50 and fallback chain 0
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [0, { price: "100000000", exp: 8, timestamp: currentTimestamp }],
          [50, { price: "999999999", exp: 8, timestamp: currentTimestamp }],
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({
        prices: mockPrices,
      } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should use configured chain 50, not fallback chain 0
      expect(cache.has(mint1)).toBe(true);
      const price = cache.get(mint1);
      expect(price).toBeDefined();
      expect(price!.price).toBe(999999999n);
    });
  });

  describe("Filter out stale prices", () => {
    it("should skip stale prices in fallback scan", async () => {
      const mint1 = "So11111111111111111111111111111111111111112"; // SOL, not a stablecoin
      const oraclePubkey = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
      
      const reserveCache: ReserveCache = new Map([
        [
          mint1,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            cumulativeBorrowRateBsfRaw: 1000000000000000000n,
            collateralMint: "mock-collateral-mint",
            collateralExchangeRateUi: 1.0,
            scopePriceChain: [100], // Invalid chain
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oraclePubkey],
          },
        ],
      ]);

      // Mock Scope data with stale price at chain 0 and fresh price at chain 3
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const staleTimestamp = currentTimestamp - 60; // 60 seconds old (stale)
      const mockPrices = createMockScopePriceArray(
        new Map([
          [0, { price: "100000000", exp: 8, timestamp: staleTimestamp }],
          [3, { price: "200000000", exp: 8, timestamp: currentTimestamp }],
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({
        prices: mockPrices,
      } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should skip stale chain 0 and use fresh chain 3
      expect(cache.has(mint1)).toBe(true);
      const price = cache.get(mint1);
      expect(price).toBeDefined();
      expect(price!.price).toBe(200000000n);
    });
  });
});
