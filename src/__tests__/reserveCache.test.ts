import { describe, it, expect, vi, beforeEach } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { loadReserves } from "../cache/reserveCache.js";
import * as decoder from "../kamino/decoder.js";
import * as discriminator from "../kamino/decode/discriminator.js";

// Mock the dependencies
vi.mock("../observability/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("Reserve Cache Tests", () => {
  let mockConnection: Connection;
  let marketPubkey: PublicKey;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnection = {} as Connection;
    marketPubkey = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
  });

  describe("loadReserves", () => {
    it("should load reserves and build cache keyed by mint", async () => {
      // Mock getProgramAccounts to return 2 reserve pubkeys
      const reserve1Pubkey = new PublicKey(
        "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"
      );
      const reserve2Pubkey = new PublicKey(
        "FRYBbRFXJ2fKJZ6q5jCQvK5c7cRZNP1jVcSPP6NEupXo"
      );

      mockConnection.getProgramAccounts = vi.fn().mockResolvedValue([
        { pubkey: reserve1Pubkey, account: {} },
        { pubkey: reserve2Pubkey, account: {} },
      ]);

      // Mock getMultipleAccountsInfo to return account data
      const mockAccountData1 = Buffer.alloc(100);
      const mockAccountData2 = Buffer.alloc(100);

      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: mockAccountData1 },
        { data: mockAccountData2 },
      ]);

      // Mock discriminator
      vi.spyOn(discriminator, "anchorDiscriminator").mockReturnValue(
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
      );

      // Mock decodeReserve
      const mint1 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const mint2 = "So11111111111111111111111111111111111111112";
      const oracle1 = "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix";
      const oracle2 = "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo";

      vi.spyOn(decoder, "decodeReserve").mockImplementation((_data, pubkey) => {
        if (pubkey.equals(reserve1Pubkey)) {
          return {
            reservePubkey: reserve1Pubkey.toString(),
            marketPubkey: marketPubkey.toString(),
            liquidityMint: mint1,
            collateralMint: "collateral1",
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oracle1],
            loanToValueRatio: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            totalBorrowed: "1000000",
            availableLiquidity: "5000000",
            cumulativeBorrowRate: "10000000000",
            collateralExchangeRateBsf: "1000000000000000000",
            scopePriceChain: null,
          };
        } else {
          return {
            reservePubkey: reserve2Pubkey.toString(),
            marketPubkey: marketPubkey.toString(),
            liquidityMint: mint2,
            collateralMint: "collateral2",
            liquidityDecimals: 9,
            collateralDecimals: 9,
            oraclePubkeys: [oracle2],
            loanToValueRatio: 70,
            liquidationThreshold: 75,
            liquidationBonus: 450,
            borrowFactor: 100,
            totalBorrowed: "2000000",
            availableLiquidity: "10000000",
            cumulativeBorrowRate: "10000000000",
            collateralExchangeRateBsf: "1000000000000000000",
            scopePriceChain: null,
          };
        }
      });

      // Mock setReserveMintCache
      const setReserveMintCacheSpy = vi.spyOn(decoder, "setReserveMintCache");

      // Execute
      const cache = await loadReserves(mockConnection, marketPubkey);

      // Verify
      expect(mockConnection.getProgramAccounts).toHaveBeenCalledTimes(1);
      expect(mockConnection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
      expect(decoder.decodeReserve).toHaveBeenCalledTimes(2);

      // Verify cache has 2 entries keyed by mint
      expect(cache.size).toBe(2);
      expect(cache.has(mint1)).toBe(true);
      expect(cache.has(mint2)).toBe(true);

      // Verify reserve 1
      const entry1 = cache.get(mint1);
      expect(entry1).toBeDefined();
      expect(entry1!.reservePubkey.toString()).toBe(reserve1Pubkey.toString());
      expect(entry1!.availableAmount).toBe(5000000n);
      expect(entry1!.loanToValue).toBe(75);
      expect(entry1!.liquidationThreshold).toBe(80);
      expect(entry1!.liquidationBonus).toBe(500);
      expect(entry1!.oraclePubkeys.length).toBe(1);
      expect(entry1!.oraclePubkeys[0].toString()).toBe(oracle1);

      // Verify reserve 2
      const entry2 = cache.get(mint2);
      expect(entry2).toBeDefined();
      expect(entry2!.reservePubkey.toString()).toBe(reserve2Pubkey.toString());
      expect(entry2!.availableAmount).toBe(10000000n);
      expect(entry2!.loanToValue).toBe(70);
      expect(entry2!.liquidationThreshold).toBe(75);
      expect(entry2!.liquidationBonus).toBe(450);
      expect(entry2!.oraclePubkeys.length).toBe(1);
      expect(entry2!.oraclePubkeys[0].toString()).toBe(oracle2);

      // Verify setReserveMintCache was called for both reserves
      expect(setReserveMintCacheSpy).toHaveBeenCalledTimes(2);
      expect(setReserveMintCacheSpy).toHaveBeenCalledWith(
        reserve1Pubkey.toString(),
        mint1
      );
      expect(setReserveMintCacheSpy).toHaveBeenCalledWith(
        reserve2Pubkey.toString(),
        mint2
      );
    });

    it("should filter reserves by market", async () => {
      const reserve1Pubkey = new PublicKey(
        "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"
      );
      const reserve2Pubkey = new PublicKey(
        "FRYBbRFXJ2fKJZ6q5jCQvK5c7cRZNP1jVcSPP6NEupXo"
      );
      const otherMarket = new PublicKey(
        "HEcgW6bcyX9yhTc6Xv5Gd1wYEMV7yZ7R5eB4kMfXy4Pa"
      );

      mockConnection.getProgramAccounts = vi.fn().mockResolvedValue([
        { pubkey: reserve1Pubkey, account: {} },
        { pubkey: reserve2Pubkey, account: {} },
      ]);

      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: Buffer.alloc(100) },
        { data: Buffer.alloc(100) },
      ]);

      vi.spyOn(discriminator, "anchorDiscriminator").mockReturnValue(
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
      );

      // Reserve 1 belongs to our market, Reserve 2 belongs to a different market
      vi.spyOn(decoder, "decodeReserve").mockImplementation((_data, pubkey) => {
        if (pubkey.equals(reserve1Pubkey)) {
          return {
            reservePubkey: reserve1Pubkey.toString(),
            marketPubkey: marketPubkey.toString(), // Matches
            liquidityMint: "mint1",
            collateralMint: "collateral1",
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [],
            loanToValueRatio: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            totalBorrowed: "1000000",
            availableLiquidity: "5000000",
            cumulativeBorrowRate: "10000000000",
            collateralExchangeRateBsf: "1000000000000000000",
            scopePriceChain: null,
          };
        } else {
          return {
            reservePubkey: reserve2Pubkey.toString(),
            marketPubkey: otherMarket.toString(), // Different market
            liquidityMint: "mint2",
            collateralMint: "collateral2",
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [],
            loanToValueRatio: 70,
            liquidationThreshold: 75,
            liquidationBonus: 450,
            borrowFactor: 100,
            totalBorrowed: "2000000",
            availableLiquidity: "10000000",
            cumulativeBorrowRate: "10000000000",
            collateralExchangeRateBsf: "1000000000000000000",
            scopePriceChain: null,
          };
        }
      });

      vi.spyOn(decoder, "setReserveMintCache");

      const cache = await loadReserves(mockConnection, marketPubkey);

      // Only reserve 1 should be in cache (matches market)
      expect(cache.size).toBe(1);
      expect(cache.has("mint1")).toBe(true);
      expect(cache.has("mint2")).toBe(false);
    });

    it("should handle empty reserve list", async () => {
      mockConnection.getProgramAccounts = vi.fn().mockResolvedValue([]);
      mockConnection.getMultipleAccountsInfo = vi.fn();

      vi.spyOn(discriminator, "anchorDiscriminator").mockReturnValue(
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
      );

      const cache = await loadReserves(mockConnection, marketPubkey);

      expect(cache.size).toBe(0);
      expect(mockConnection.getMultipleAccountsInfo).not.toHaveBeenCalled();
    });

    it("should handle null account data gracefully", async () => {
      const reserve1Pubkey = new PublicKey(
        "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"
      );

      mockConnection.getProgramAccounts = vi.fn().mockResolvedValue([
        { pubkey: reserve1Pubkey, account: {} },
      ]);

      // Return null data
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        null,
      ]);

      vi.spyOn(discriminator, "anchorDiscriminator").mockReturnValue(
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
      );

      const cache = await loadReserves(mockConnection, marketPubkey);

      expect(cache.size).toBe(0);
    });

    it("should handle decode errors gracefully", async () => {
      const reserve1Pubkey = new PublicKey(
        "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"
      );

      mockConnection.getProgramAccounts = vi.fn().mockResolvedValue([
        { pubkey: reserve1Pubkey, account: {} },
      ]);

      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: Buffer.alloc(100) },
      ]);

      vi.spyOn(discriminator, "anchorDiscriminator").mockReturnValue(
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
      );

      // Mock decodeReserve to throw
      vi.spyOn(decoder, "decodeReserve").mockImplementation(() => {
        throw new Error("Invalid reserve data");
      });

      const cache = await loadReserves(mockConnection, marketPubkey);

      // Should return empty cache without throwing
      expect(cache.size).toBe(0);
    });

    it("should batch fetch accounts in chunks", async () => {
      // Create 150 reserve pubkeys to test batching (batch size is 100)
      const reservePubkeys = Array.from({ length: 150 }, () =>
        PublicKey.unique()
      );

      mockConnection.getProgramAccounts = vi
        .fn()
        .mockResolvedValue(
          reservePubkeys.map((pubkey) => ({ pubkey, account: {} }))
        );

      // Mock to track how many times getMultipleAccountsInfo is called
      mockConnection.getMultipleAccountsInfo = vi
        .fn()
        .mockImplementation(async (pubkeys: PublicKey[]) => {
          return pubkeys.map(() => ({ data: Buffer.alloc(100) }));
        });

      vi.spyOn(discriminator, "anchorDiscriminator").mockReturnValue(
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
      );

      // Mock decodeReserve to return valid reserves for all
      vi.spyOn(decoder, "decodeReserve").mockImplementation((_data, pubkey) => {
        const pubkeyStr = pubkey.toString();
        // Create a unique mint for each pubkey
        const mint = `mint-${pubkeyStr}`;
        
        return {
          reservePubkey: pubkeyStr,
          marketPubkey: marketPubkey.toString(),
          liquidityMint: mint,
          collateralMint: "collateral",
          liquidityDecimals: 6,
          collateralDecimals: 6,
          oraclePubkeys: [],
          loanToValueRatio: 75,
          liquidationThreshold: 80,
          liquidationBonus: 500,
          borrowFactor: 100,
          totalBorrowed: "1000000",
          availableLiquidity: "5000000",
          cumulativeBorrowRate: "10000000000",
          collateralExchangeRateBsf: "1000000000000000000",
          scopePriceChain: null,
        };
      });

      vi.spyOn(decoder, "setReserveMintCache");

      const cache = await loadReserves(mockConnection, marketPubkey);

      // Should be called twice: once for first 100, once for remaining 50
      expect(mockConnection.getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
      expect(cache.size).toBe(150);
    });
  });
});
