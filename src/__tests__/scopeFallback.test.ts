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

describe("Scope Chain Pricing (replaces fallback chain tests)", () => {
  let mockConnection: Connection;
  const SCOPE_PROGRAM_ID = new PublicKey("HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ");

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnection = {} as Connection;
    scopeMintChainMap.clear();
  });

  /**
   * Helper to create mock Scope price data at a specific chain index.
   * Compatible with Scope.priceToDecimal: uiPrice = value * 10^(-exp)
   */
  function createMockScopePriceArray(validChains: Map<number, { price: string; exp: number; timestamp: number }>): any[] {
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

  describe("Configured chain is used directly (no fallback scanning)", () => {
    it("should price a mint using its reserve-configured Scope chain", async () => {
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
        scopePriceChain: [3],
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

      // Populate scopeMintChainMap as loadReserves would
      scopeMintChainMap.set(mint1, [3]);

      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [3, { price: "8600000000", exp: 8, timestamp: currentTimestamp }], // 86 USD
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({ prices: mockPrices } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      expect(cache.has(mint1)).toBe(true);
      const price = cache.get(mint1)!;
      expect(price.oracleType).toBe("scope");
      expect(price.exponent).toBe(-8);
      // 86 USD = 8600000000 / 1e8 → price stored as BigInt(Math.floor(86 * 1e8)) = 8600000000n
      expect(price.price).toBe(8600000000n);
    });

    it("should return no price when the configured chain has no data", async () => {
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
        scopePriceChain: [100],
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

      // Configure chain [100] but prices[100] is null
      scopeMintChainMap.set(mint1, [100]);

      vi.mocked(OraclePrices.decode).mockReturnValue({
        prices: new Array(512).fill(null),
      } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      // No price because prices[100] is null - no fallback scanning
      expect(cache.has(mint1)).toBe(false);
    });

    it("should reject stale prices from the configured chain without fallback", async () => {
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
        scopePriceChain: [3],
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

      scopeMintChainMap.set(mint1, [3]);

      const staleTimestamp = Math.floor(Date.now() / 1000) - 60; // 60s stale
      const mockPrices = createMockScopePriceArray(
        new Map([
          [3, { price: "8600000000", exp: 8, timestamp: staleTimestamp }],
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({ prices: mockPrices } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      // No price because chain is stale; no fallback to other chains
      expect(cache.has(mint1)).toBe(false);
    });
  });
});
