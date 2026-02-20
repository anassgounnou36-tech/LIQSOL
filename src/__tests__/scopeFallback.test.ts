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
      const reservePubkey = PublicKey.unique();
      
      const reserveEntry = {
        reservePubkey,
        liquidityMint: mint1,
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
      };
      
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint1, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

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

    it("should not use fallback chain 3; no price cached when configured chains and chain 0 fail", async () => {
      const mint1 = "So11111111111111111111111111111111111111112"; // SOL, not a stablecoin
      const oraclePubkey = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
      const reservePubkey = PublicKey.unique();
      
      const reserveEntry = {
        reservePubkey,
        liquidityMint: mint1,
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
      };
      
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint1, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      // Mock Scope data with price only at chain 3 (which is now excluded)
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

      // Should NOT have price for mint since chain 3 is excluded from fallback
      expect(cache.has(mint1)).toBe(false);
    });

    it("should scan curated fallback candidates when primary fallbacks fail", async () => {
      const mint1 = "So11111111111111111111111111111111111111112"; // SOL, not a stablecoin
      const oraclePubkey = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
      const reservePubkey = PublicKey.unique();
      
      const reserveEntry = {
        reservePubkey,
        liquidityMint: mint1,
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
      };
      
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint1, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      // Mock Scope data with price only at chain 3 (in curated FALLBACK_CHAIN_CANDIDATES, not in override chains)
      // Use a realistic SOL price (~100 USD) to pass the SOL sanity check
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [3, { price: "10000000000", exp: 8, timestamp: currentTimestamp }],
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({
        prices: mockPrices,
      } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      // Pass allowedLiquidityMints to enable allowlist mode (which enables bounded curated scan)
      const cache = await loadOracles(mockConnection, reserveCache, new Set([mint1]));

      // Should have found price via curated fallback candidate 3
      expect(cache.has(mint1)).toBe(true);
      const price = cache.get(mint1);
      expect(price).toBeDefined();
      expect(price!.price).toBe(10000000000n);
    });

    it("should return null when no valid price found after exhaustive search", async () => {
      const mint1 = "So11111111111111111111111111111111111111112"; // SOL, not a stablecoin
      const oraclePubkey = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
      const reservePubkey = PublicKey.unique();
      
      const reserveEntry = {
        reservePubkey,
        liquidityMint: mint1,
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
      };
      
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint1, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

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
      const reservePubkey = PublicKey.unique();
      
      const reserveEntry = {
        reservePubkey,
        liquidityMint: mint1,
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
      };
      
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint1, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };
      
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
      const reservePubkey = PublicKey.unique();
      
      const reserveEntry = {
        reservePubkey,
        liquidityMint: mint1,
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
      };
      
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint1, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      // Mock Scope data with stale price at chain 0 and fresh price at chain 3 (curated fallback)
      // Use realistic SOL price (~200 USD) to pass the SOL sanity check
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const staleTimestamp = currentTimestamp - 60; // 60 seconds old (stale)
      const mockPrices = createMockScopePriceArray(
        new Map([
          [0, { price: "10000000000", exp: 8, timestamp: staleTimestamp }],
          [3, { price: "20000000000", exp: 8, timestamp: currentTimestamp }],
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({
        prices: mockPrices,
      } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      // Pass allowedLiquidityMints to enable allowlist mode (which enables bounded curated scan)
      const cache = await loadOracles(mockConnection, reserveCache, new Set([mint1]));

      // Should skip stale chain 0 and use fresh chain 3 (curated fallback)
      expect(cache.has(mint1)).toBe(true);
      const price = cache.get(mint1);
      expect(price).toBeDefined();
      expect(price!.price).toBe(20000000000n);
    });
  });

  describe("Magnitude sanity checks for price usability", () => {
    it("should reject extremely tiny prices (e.g., ~1e-6 USD)", async () => {
      const mint1 = "So11111111111111111111111111111111111111112";
      const oraclePubkey = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
      const reservePubkey = PublicKey.unique();
      
      const reserveEntry = {
        reservePubkey,
        liquidityMint: mint1,
        availableAmount: 5000000n,
        cumulativeBorrowRate: 0n,
        cumulativeBorrowRateBsfRaw: 1000000000000000000n,
        collateralMint: "mock-collateral-mint",
        collateralExchangeRateUi: 1.0,
        scopePriceChain: [0],
        loanToValue: 75,
        liquidationThreshold: 80,
        liquidationBonus: 500,
        borrowFactor: 100,
        liquidityDecimals: 6,
        collateralDecimals: 6,
        oraclePubkeys: [oraclePubkey],
      };
      
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint1, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      // Mock Scope data with placeholder-like price: value = 1e12 with exp = -18 → ~1e-6 USD
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [0, { price: "1000000000000", exp: 18, timestamp: currentTimestamp }], // 1e12 * 10^-18 = 1e-6
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

      // Should NOT have price for mint since magnitude check should reject ~1e-6 USD
      expect(cache.has(mint1)).toBe(false);
    });

    it("should reject extremely huge prices (e.g., > 1e7 USD)", async () => {
      const mint1 = "So11111111111111111111111111111111111111112";
      const oraclePubkey = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
      const reservePubkey = PublicKey.unique();
      
      const reserveEntry = {
        reservePubkey,
        liquidityMint: mint1,
        availableAmount: 5000000n,
        cumulativeBorrowRate: 0n,
        cumulativeBorrowRateBsfRaw: 1000000000000000000n,
        collateralMint: "mock-collateral-mint",
        collateralExchangeRateUi: 1.0,
        scopePriceChain: [0],
        loanToValue: 75,
        liquidationThreshold: 80,
        liquidationBonus: 500,
        borrowFactor: 100,
        liquidityDecimals: 6,
        collateralDecimals: 6,
        oraclePubkeys: [oraclePubkey],
      };
      
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint1, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      // Mock Scope data with absurdly huge price: value = 1e20 with exp = -8 → 1e12 USD
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [0, { price: "100000000000000000000", exp: 8, timestamp: currentTimestamp }], // 1e20 * 10^-8 = 1e12
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

      // Should NOT have price for mint since magnitude check should reject huge prices
      expect(cache.has(mint1)).toBe(false);
    });

    it("should accept reasonable prices (e.g., typical crypto prices)", async () => {
      const mint1 = "So11111111111111111111111111111111111111112";
      const oraclePubkey = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
      const reservePubkey = PublicKey.unique();
      
      const reserveEntry = {
        reservePubkey,
        liquidityMint: mint1,
        availableAmount: 5000000n,
        cumulativeBorrowRate: 0n,
        cumulativeBorrowRateBsfRaw: 1000000000000000000n,
        collateralMint: "mock-collateral-mint",
        collateralExchangeRateUi: 1.0,
        scopePriceChain: [0],
        loanToValue: 75,
        liquidationThreshold: 80,
        liquidationBonus: 500,
        borrowFactor: 100,
        liquidityDecimals: 6,
        collateralDecimals: 6,
        oraclePubkeys: [oraclePubkey],
      };
      
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint1, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      // Mock Scope data with reasonable price: value = 100e8 with exp = -8 → $100 USD
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [0, { price: "10000000000", exp: 8, timestamp: currentTimestamp }], // 100e8 * 10^-8 = 100
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

      // Should have price for mint since magnitude check accepts reasonable prices
      expect(cache.has(mint1)).toBe(true);
      const price = cache.get(mint1);
      expect(price).toBeDefined();
      expect(price!.price).toBe(10000000000n);
    });
  });
});
