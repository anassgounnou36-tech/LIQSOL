import { describe, it, expect, vi, beforeEach } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadMarketCaches } from "../cache/index.js";
import * as reserveCache from "../cache/reserveCache.js";
import * as oracleCache from "../cache/oracleCache.js";

// Mock the dependencies
vi.mock("../observability/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("Cache Index Integration Tests", () => {
  let mockConnection: Connection;
  let marketPubkey: PublicKey;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnection = {} as Connection;
    marketPubkey = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
  });

  describe("loadMarketCaches", () => {
    it("should load both reserves and oracles", async () => {
      const mockReserveCache = new Map([
        [
          "mint1",
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            scopePriceChain: null,
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
          borrowFactor: 100,
            oraclePubkeys: [PublicKey.unique()],
            liquidityDecimals: 6,
            collateralDecimals: 6,
          },
        ],
      ]);

      const mockOracleCache = new Map([
        [
          "mint1",
          {
            price: 100000000n,
            confidence: 50000n,
            slot: 1000000n,
            exponent: -8,
            oracleType: "pyth" as const,
          },
        ],
      ]);

      const loadReservesSpy = vi
        .spyOn(reserveCache, "loadReserves")
        .mockResolvedValue(mockReserveCache);
      const loadOraclesSpy = vi
        .spyOn(oracleCache, "loadOracles")
        .mockResolvedValue(mockOracleCache);

      const result = await loadMarketCaches(mockConnection, marketPubkey);

      // Verify both functions were called
      expect(loadReservesSpy).toHaveBeenCalledWith(
        mockConnection,
        marketPubkey
      );
      expect(loadOraclesSpy).toHaveBeenCalledWith(
        mockConnection,
        mockReserveCache
      );

      // Verify result structure
      expect(result).toHaveProperty("reserves");
      expect(result).toHaveProperty("oracles");
      expect(result.reserves).toBe(mockReserveCache);
      expect(result.oracles).toBe(mockOracleCache);
    });

    it("should call loadReserves before loadOracles", async () => {
      const callOrder: string[] = [];

      vi.spyOn(reserveCache, "loadReserves").mockImplementation(async () => {
        callOrder.push("reserves");
        return new Map();
      });

      vi.spyOn(oracleCache, "loadOracles").mockImplementation(async () => {
        callOrder.push("oracles");
        return new Map();
      });

      await loadMarketCaches(mockConnection, marketPubkey);

      expect(callOrder).toEqual(["reserves", "oracles"]);
    });

    it("should handle empty caches", async () => {
      vi.spyOn(reserveCache, "loadReserves").mockResolvedValue(new Map());
      vi.spyOn(oracleCache, "loadOracles").mockResolvedValue(new Map());

      const result = await loadMarketCaches(mockConnection, marketPubkey);

      expect(result.reserves.size).toBe(0);
      expect(result.oracles.size).toBe(0);
    });

    it("should propagate errors from loadReserves", async () => {
      const error = new Error("Failed to load reserves");
      vi.spyOn(reserveCache, "loadReserves").mockRejectedValue(error);

      await expect(
        loadMarketCaches(mockConnection, marketPubkey)
      ).rejects.toThrow("Failed to load reserves");
    });

    it("should propagate errors from loadOracles", async () => {
      vi.spyOn(reserveCache, "loadReserves").mockResolvedValue(new Map());

      const error = new Error("Failed to load oracles");
      vi.spyOn(oracleCache, "loadOracles").mockRejectedValue(error);

      await expect(
        loadMarketCaches(mockConnection, marketPubkey)
      ).rejects.toThrow("Failed to load oracles");
    });
  });
});
