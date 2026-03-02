import { describe, it, expect, vi, beforeEach } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { loadOracles } from "../cache/oracleCache.js";
import type { ReserveCache } from "../cache/reserveCache.js";
import { extractScopePriceChain } from "../kamino/decode/reserveDecoder.js";

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
import { scopeOracleMintChains } from "../cache/reserveCache.js";

const SCOPE_PROGRAM_ID = new PublicKey("HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ");

/**
 * Helper to create mock Scope price data at specific chain indices.
 * The format is compatible with Scope.priceToDecimal:
 *   uiPrice = value * 10^(-exp)
 */
function createMockScopePriceArray(
  validChains: Map<number, { price: string; exp: number; timestamp: number }>
): any[] {
  const maxChain = validChains.size > 0 ? Math.max(...Array.from(validChains.keys())) : 0;
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

function makeReserveEntry(
  reservePubkey: PublicKey,
  mint: string,
  oraclePubkey: PublicKey,
  scopePriceChain: number[] | null
) {
  return {
    reservePubkey,
    liquidityMint: mint,
    availableAmount: 5000000n,
    cumulativeBorrowRate: 0n,
    cumulativeBorrowRateBsfRaw: 1000000000000000000n,
    collateralMint: "mock-collateral-mint",
    collateralExchangeRateUi: 1.0,
    scopePriceChain,
    loanToValue: 75,
    liquidationThreshold: 80,
    liquidationBonus: 500,
    borrowFactor: 100,
    liquidityDecimals: 6,
    collateralDecimals: 6,
    oraclePubkeys: [oraclePubkey],
  };
}

function setScopeOracleMintChain(
  oraclePubkey: PublicKey,
  mint: string,
  chain: number[]
): void {
  const oracleKey = oraclePubkey.toString();
  let mintChains = scopeOracleMintChains.get(oracleKey);
  if (!mintChains) {
    mintChains = new Map<string, number[]>();
    scopeOracleMintChains.set(oracleKey, mintChains);
  }
  mintChains.set(mint, chain);
}

describe("Scope Chain Pricing Tests", () => {
  let mockConnection: Connection;
  const oraclePubkey = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnection = {} as Connection;
    scopeOracleMintChains.clear();
  });

  describe("Scope chain sentinel parsing", () => {
    const scopeFeed = { toString: () => "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH" };

    it("parses [0, 3, 512, 65535] into [0, 3]", () => {
      const chain = extractScopePriceChain({
        scopeConfiguration: {
          priceFeed: scopeFeed,
          priceChain: [0, 3, 512, 65535],
        },
      });
      expect(chain).toEqual([0, 3]);
    });

    it("parses [512, 65535, 512, 65535] as null", () => {
      const chain = extractScopePriceChain({
        scopeConfiguration: {
          priceFeed: scopeFeed,
          priceChain: [512, 65535, 512, 65535],
        },
      });
      expect(chain).toBeNull();
    });
  });

  describe("Multi-hop chain pricing", () => {
    it("computes USD price from a two-hop chain (product of prices)", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const reservePubkey = PublicKey.unique();

      // chain [0, 1]: prices[0] = 86.5 USD (SOL/USD), prices[1] = 1.15 (LST/SOL ratio)
      // Expected final price: 86.5 * 1.15 = 99.475 USD
      setScopeOracleMintChain(oraclePubkey, mint, [0, 1]);

      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [0, { price: "8650000000", exp: 8, timestamp: currentTimestamp }], // 86.5 USD
          [1, { price: "115000000", exp: 8, timestamp: currentTimestamp }],  // 1.15
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({ prices: mockPrices } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const reserveEntry = makeReserveEntry(reservePubkey, mint, oraclePubkey, [0, 1]);
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      const cache = await loadOracles(mockConnection, reserveCache);

      expect(cache.has(mint)).toBe(true);
      const priceData = cache.get(mint)!;
      expect(priceData.oracleType).toBe("scope");
      expect(priceData.exponent).toBe(-8);

      // 99.475 USD * 1e8 = 9947500000; allow ±1 for float rounding
      const uiPrice = Number(priceData.price) * Math.pow(10, priceData.exponent);
      expect(uiPrice).toBeCloseTo(99.475, 2);
    });

    it("computes USD price from a single-element chain", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const reservePubkey = PublicKey.unique();

      // chain [50]: prices[50] = 100 USD
      setScopeOracleMintChain(oraclePubkey, mint, [50]);

      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [50, { price: "10000000000", exp: 8, timestamp: currentTimestamp }], // 100 USD
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({ prices: mockPrices } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const reserveEntry = makeReserveEntry(reservePubkey, mint, oraclePubkey, [50]);
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      const cache = await loadOracles(mockConnection, reserveCache);

      expect(cache.has(mint)).toBe(true);
      const priceData = cache.get(mint)!;
      expect(priceData.price).toBe(10000000000n);
      expect(priceData.exponent).toBe(-8);
    });
  });

  describe("Invalid chain handling", () => {
    it("returns no price when chain index has no data (missing price at index)", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const reservePubkey = PublicKey.unique();

      // chain [100]: prices[100] = null (missing)
      setScopeOracleMintChain(oraclePubkey, mint, [100]);

      vi.mocked(OraclePrices.decode).mockReturnValue({
        prices: new Array(512).fill(null),
      } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const reserveEntry = makeReserveEntry(reservePubkey, mint, oraclePubkey, [100]);
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should not have price since prices[100] is null (getPriceFromScopeChain throws)
      expect(cache.has(mint)).toBe(false);
    });

    it("returns no price when no valid prices exist in the oracle", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const reservePubkey = PublicKey.unique();

      // chain [1]: prices[1] = null
      setScopeOracleMintChain(oraclePubkey, mint, [1]);

      vi.mocked(OraclePrices.decode).mockReturnValue({
        prices: new Array(512).fill(null),
      } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const reserveEntry = makeReserveEntry(reservePubkey, mint, oraclePubkey, [1]);
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      const cache = await loadOracles(mockConnection, reserveCache);

      expect(cache.has(mint)).toBe(false);
    });
  });

  describe("Stale price rejection", () => {
    it("rejects a stale chain price (age > 120s)", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const reservePubkey = PublicKey.unique();

      // Use chain [1] (non-zero, valid according to isScopeChainValid)
      setScopeOracleMintChain(oraclePubkey, mint, [1]);

      const staleTimestamp = Math.floor(Date.now() / 1000) - 130; // 130 seconds old (> 120s threshold)
      const mockPrices = createMockScopePriceArray(
        new Map([
          [1, { price: "10000000000", exp: 8, timestamp: staleTimestamp }],
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({ prices: mockPrices } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const reserveEntry = makeReserveEntry(reservePubkey, mint, oraclePubkey, [1]);
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should not have price since it's stale
      expect(cache.has(mint)).toBe(false);
    });

    it("rejects a multi-hop chain where any hop has a stale price", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const reservePubkey = PublicKey.unique();

      setScopeOracleMintChain(oraclePubkey, mint, [0, 1]);

      const currentTimestamp = Math.floor(Date.now() / 1000);
      const staleTimestamp = currentTimestamp - 130; // 130 seconds old (> 120s threshold)

      const mockPrices = createMockScopePriceArray(
        new Map([
          [0, { price: "8650000000", exp: 8, timestamp: staleTimestamp }], // stale
          [1, { price: "115000000", exp: 8, timestamp: currentTimestamp }], // fresh
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({ prices: mockPrices } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const reserveEntry = makeReserveEntry(reservePubkey, mint, oraclePubkey, [0, 1]);
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should not have price since the oldest timestamp is stale
      expect(cache.has(mint)).toBe(false);
    });
  });

  describe("Magnitude sanity checks", () => {
    it("rejects extremely tiny prices (e.g., ~1e-6 USD)", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const reservePubkey = PublicKey.unique();

      // Use chain [1] (non-zero, valid)
      setScopeOracleMintChain(oraclePubkey, mint, [1]);

      // 1e12 * 10^(-18) = 1e-6 USD
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [1, { price: "1000000000000", exp: 18, timestamp: currentTimestamp }],
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({ prices: mockPrices } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const reserveEntry = makeReserveEntry(reservePubkey, mint, oraclePubkey, [1]);
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      const cache = await loadOracles(mockConnection, reserveCache);

      expect(cache.has(mint)).toBe(false);
    });

    it("rejects extremely large prices (e.g., > 1,000,000 USD)", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const reservePubkey = PublicKey.unique();

      // Use chain [1] (non-zero, valid)
      setScopeOracleMintChain(oraclePubkey, mint, [1]);

      // 1e20 * 10^(-8) = 1e12 USD
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [1, { price: "100000000000000000000", exp: 8, timestamp: currentTimestamp }],
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({ prices: mockPrices } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const reserveEntry = makeReserveEntry(reservePubkey, mint, oraclePubkey, [1]);
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      const cache = await loadOracles(mockConnection, reserveCache);

      expect(cache.has(mint)).toBe(false);
    });

    it("accepts reasonable prices (e.g., $100 USD)", async () => {
      const mint = "So11111111111111111111111111111111111111112";
      const reservePubkey = PublicKey.unique();

      // Use chain [1] (non-zero, valid)
      setScopeOracleMintChain(oraclePubkey, mint, [1]);

      // 1e10 * 10^(-8) = 100 USD
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const mockPrices = createMockScopePriceArray(
        new Map([
          [1, { price: "10000000000", exp: 8, timestamp: currentTimestamp }],
        ])
      );

      vi.mocked(OraclePrices.decode).mockReturnValue({ prices: mockPrices } as any);

      const scopeData = Buffer.alloc(1000);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: scopeData, owner: SCOPE_PROGRAM_ID },
      ]);

      const reserveEntry = makeReserveEntry(reservePubkey, mint, oraclePubkey, [1]);
      const reserveCache: ReserveCache = {
        byMint: new Map([[mint, reserveEntry]]),
        byReserve: new Map([[reservePubkey.toString(), reserveEntry]]),
      };

      const cache = await loadOracles(mockConnection, reserveCache);

      expect(cache.has(mint)).toBe(true);
      const priceData = cache.get(mint)!;
      expect(priceData.price).toBe(10000000000n);
      expect(priceData.exponent).toBe(-8);
      expect(priceData.oracleType).toBe("scope");
    });
  });
});
