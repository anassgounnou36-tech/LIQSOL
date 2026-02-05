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
            availableAmountRaw: "5000000",
            borrowedAmountSfRaw: "1000000000000000000000000",
            cumulativeBorrowRateBsfRaw: "1000000000000000000",
            collateralMintTotalSupplyRaw: "1000000",
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
            availableAmountRaw: "10000000",
            borrowedAmountSfRaw: "2000000000000000000000000",
            cumulativeBorrowRateBsfRaw: "1000000000000000000",
            collateralMintTotalSupplyRaw: "1000000",
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

      // Verify cache has 4 entries: 2 reserves × 2 keys each (liquidity + collateral)
      expect(cache.size).toBe(4);
      expect(cache.has(mint1)).toBe(true);
      expect(cache.has(mint2)).toBe(true);
      expect(cache.has("collateral1")).toBe(true);
      expect(cache.has("collateral2")).toBe(true);

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

      // Verify setReserveMintCache was called for both reserves with both mints
      expect(setReserveMintCacheSpy).toHaveBeenCalledTimes(2);
      expect(setReserveMintCacheSpy).toHaveBeenCalledWith(
        reserve1Pubkey.toString(),
        mint1,
        "collateral1"
      );
      expect(setReserveMintCacheSpy).toHaveBeenCalledWith(
        reserve2Pubkey.toString(),
        mint2,
        "collateral2"
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
            availableAmountRaw: "5000000",
            borrowedAmountSfRaw: "1000000000000000000000000",
            cumulativeBorrowRateBsfRaw: "1000000000000000000",
            collateralMintTotalSupplyRaw: "1000000",
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
            availableAmountRaw: "10000000",
            borrowedAmountSfRaw: "2000000000000000000000000",
            cumulativeBorrowRateBsfRaw: "1000000000000000000",
            collateralMintTotalSupplyRaw: "1000000",
            scopePriceChain: null,
          };
        }
      });

      vi.spyOn(decoder, "setReserveMintCache");

      const cache = await loadReserves(mockConnection, marketPubkey);

      // Only reserve 1 should be in cache (matches market)
      // Cache stores both liquidity and collateral mints, so 2 entries for 1 reserve
      expect(cache.size).toBe(2);
      expect(cache.has("mint1")).toBe(true);
      expect(cache.has("collateral1")).toBe(true);
      expect(cache.has("mint2")).toBe(false);
      expect(cache.has("collateral2")).toBe(false);
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
        const collateralMint = `collateral-${pubkeyStr}`;
        
        return {
          reservePubkey: pubkeyStr,
          marketPubkey: marketPubkey.toString(),
          liquidityMint: mint,
          collateralMint: collateralMint,
          liquidityDecimals: 6,
          collateralDecimals: 6,
          oraclePubkeys: [],
          loanToValueRatio: 75,
          liquidationThreshold: 80,
          liquidationBonus: 500,
          borrowFactor: 100,
          availableAmountRaw: "5000000",
          borrowedAmountSfRaw: "1000000000000000000000000",
          cumulativeBorrowRateBsfRaw: "1000000000000000000",
          collateralMintTotalSupplyRaw: "1000000",
          scopePriceChain: null,
        };
      });

      vi.spyOn(decoder, "setReserveMintCache");

      const cache = await loadReserves(mockConnection, marketPubkey);

      // Should be called twice: once for first 100, once for remaining 50
      expect(mockConnection.getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
      // Cache stores both liquidity and collateral mints: 150 reserves × 2 = 300 entries
      expect(cache.size).toBe(300);
    });

    it("should handle reserves with missing decimals and fetch from SPL mint accounts", async () => {
      const reserve1Pubkey = new PublicKey(
        "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"
      );
      // Use valid base58 PublicKey strings
      const liquidityMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      const collateralMint = new PublicKey("So11111111111111111111111111111111111111112");

      mockConnection.getProgramAccounts = vi.fn().mockResolvedValue([
        { pubkey: reserve1Pubkey, account: {} },
      ]);

      // Mock getMultipleAccountsInfo to be called twice:
      // 1. First for reserve accounts
      // 2. Second for mint accounts (fallback)
      const reserveData = Buffer.alloc(100);
      
      // Create mock mint account data with decimals at byte 44
      const liquidityMintData = Buffer.alloc(82);
      liquidityMintData[44] = 6; // USDC decimals
      
      const collateralMintData = Buffer.alloc(82);
      collateralMintData[44] = 9; // SOL decimals

      let callCount = 0;
      mockConnection.getMultipleAccountsInfo = vi
        .fn()
        .mockImplementation(async (pubkeys: PublicKey[]) => {
          callCount++;
          if (callCount === 1) {
            // First call: return reserve account data
            return [{ data: reserveData }];
          } else {
            // Second call: return mint account data for fallback
            // Need to return data for both liquidity and collateral mints
            return pubkeys.map((pk) => {
              if (pk.equals(liquidityMint)) {
                return { data: liquidityMintData };
              } else if (pk.equals(collateralMint)) {
                return { data: collateralMintData };
              }
              return null;
            });
          }
        });

      vi.spyOn(discriminator, "anchorDiscriminator").mockReturnValue(
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
      );

      // Mock decodeReserve to return reserve with missing decimals (-1)
      vi.spyOn(decoder, "decodeReserve").mockImplementation(() => ({
        reservePubkey: reserve1Pubkey.toString(),
        marketPubkey: marketPubkey.toString(),
        liquidityMint: liquidityMint.toString(),
        collateralMint: collateralMint.toString(),
        liquidityDecimals: -1, // Missing - should trigger fallback
        collateralDecimals: -1, // Missing - should trigger fallback
        oraclePubkeys: [],
        loanToValueRatio: 75,
        liquidationThreshold: 80,
        liquidationBonus: 500,
        borrowFactor: 100,
        availableAmountRaw: "5000000",
        borrowedAmountSfRaw: "1000000000000000000000000",
        cumulativeBorrowRateBsfRaw: "1000000000000000000",
        collateralMintTotalSupplyRaw: "1000000",
        scopePriceChain: null,
      }));

      vi.spyOn(decoder, "setReserveMintCache");

      const cache = await loadReserves(mockConnection, marketPubkey);

      // Verify getMultipleAccountsInfo was called twice: 
      // once for reserves, once for mints
      expect(mockConnection.getMultipleAccountsInfo).toHaveBeenCalledTimes(2);

      // Verify cache was populated (both liquidity and collateral mints)
      expect(cache.size).toBe(2);
      expect(cache.has(liquidityMint.toString())).toBe(true);
      expect(cache.has(collateralMint.toString())).toBe(true);

      // Verify decimals were resolved from mint account
      const entry = cache.get(liquidityMint.toString());
      expect(entry).toBeDefined();
      expect(entry!.liquidityDecimals).toBe(6);
      expect(entry!.collateralDecimals).toBe(9);
    });

    it("should skip caching reserves with unresolved decimals after fallback", async () => {
      const reserve1Pubkey = new PublicKey(
        "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"
      );
      const liquidityMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      const collateralMint = new PublicKey("So11111111111111111111111111111111111111112");

      mockConnection.getProgramAccounts = vi.fn().mockResolvedValue([
        { pubkey: reserve1Pubkey, account: {} },
      ]);

      let callCount = 0;
      mockConnection.getMultipleAccountsInfo = vi
        .fn()
        .mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            // First call: return reserve data
            return [{ data: Buffer.alloc(100) }];
          } else {
            // Second call: return null for mint (fallback fails)
            return [null, null];
          }
        });

      vi.spyOn(discriminator, "anchorDiscriminator").mockReturnValue(
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
      );

      // Mock decodeReserve to return reserve with missing decimals
      vi.spyOn(decoder, "decodeReserve").mockImplementation(() => ({
        reservePubkey: reserve1Pubkey.toString(),
        marketPubkey: marketPubkey.toString(),
        liquidityMint: liquidityMint.toString(),
        collateralMint: collateralMint.toString(),
        liquidityDecimals: -1, // Missing
        collateralDecimals: -1, // Missing
        oraclePubkeys: [],
        loanToValueRatio: 75,
        liquidationThreshold: 80,
        liquidationBonus: 500,
        borrowFactor: 100,
        availableAmountRaw: "5000000",
        borrowedAmountSfRaw: "1000000000000000000000000",
        cumulativeBorrowRateBsfRaw: "1000000000000000000",
        collateralMintTotalSupplyRaw: "1000000",
        scopePriceChain: null,
      }));

      vi.spyOn(decoder, "setReserveMintCache");

      const cache = await loadReserves(mockConnection, marketPubkey);

      // Reserve should not be cached since decimals couldn't be resolved
      expect(cache.size).toBe(0);
    });
  });

  describe("Exchange Rate Calculation", () => {
    it("should compute exchange rate correctly: collateralSupply / totalLiquidity", async () => {
      // Setup: Mock a reserve with known values to test exchange rate calculation
      const reservePubkey = new PublicKey(
        "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"
      );
      
      mockConnection.getProgramAccounts = vi.fn().mockResolvedValue([
        { pubkey: reservePubkey, account: {} },
      ]);

      const mockAccountData = Buffer.alloc(100);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: mockAccountData },
      ]);

      vi.spyOn(discriminator, "anchorDiscriminator").mockReturnValue(
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
      );

      // Test scenario:
      // availableAmount = 1000 tokens (raw: 1000e6 = 1000000000)
      // borrowedAmountSf = 500 tokens (scaled: 500e6 * 1e18 = 500000000000000000000000000)
      // totalLiquidity = 1000 + 500 = 1500 tokens
      // collateralSupply = 1500 tokens (raw: 1500e6 = 1500000000)
      // exchangeRate = 1500 / 1500 = 1.0
      vi.spyOn(decoder, "decodeReserve").mockReturnValue({
        reservePubkey: reservePubkey.toString(),
        marketPubkey: marketPubkey.toString(),
        liquidityMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        collateralMint: "collateral1",
        liquidityDecimals: 6,
        collateralDecimals: 6,
        oraclePubkeys: [],
        loanToValueRatio: 75,
        liquidationThreshold: 80,
        liquidationBonus: 500,
        borrowFactor: 100,
        availableAmountRaw: "1000000000", // 1000 USDC
        borrowedAmountSfRaw: "500000000000000000000000000", // 500 USDC * 1e18
        cumulativeBorrowRateBsfRaw: "1000000000000000000",
        collateralMintTotalSupplyRaw: "1500000000", // 1500 collateral tokens
        scopePriceChain: null,
      });

      vi.spyOn(decoder, "setReserveMintCache");

      const cache = await loadReserves(mockConnection, marketPubkey);

      // Verify cache entry
      const entry = cache.get("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      expect(entry).toBeDefined();
      
      // With the corrected formula: exchangeRate = collateralSupply / totalLiquidity
      // totalLiquidity = 1000 + (500e18 / 1e18) = 1000 + 500 = 1500
      // collateralSupply = 1500
      // exchangeRate = 1500 / 1500 = 1.0
      expect(entry!.collateralExchangeRateUi).toBeCloseTo(1.0, 6);
    });

    it("should compute exchange rate > 1 when collateral exceeds liquidity", async () => {
      // Test scenario with more collateral than liquidity (typical for accrued interest)
      const reservePubkey = new PublicKey(
        "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"
      );
      
      mockConnection.getProgramAccounts = vi.fn().mockResolvedValue([
        { pubkey: reservePubkey, account: {} },
      ]);

      const mockAccountData = Buffer.alloc(100);
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: mockAccountData },
      ]);

      vi.spyOn(discriminator, "anchorDiscriminator").mockReturnValue(
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
      );

      // availableAmount = 1000 tokens
      // borrowedAmountSf = 100 tokens (scaled by 1e18)
      // totalLiquidity = 1100 tokens
      // collateralSupply = 1200 tokens (more than liquidity due to accrued interest)
      // exchangeRate = 1200 / 1100 = ~1.091
      vi.spyOn(decoder, "decodeReserve").mockReturnValue({
        reservePubkey: reservePubkey.toString(),
        marketPubkey: marketPubkey.toString(),
        liquidityMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        collateralMint: "collateral1",
        liquidityDecimals: 6,
        collateralDecimals: 6,
        oraclePubkeys: [],
        loanToValueRatio: 75,
        liquidationThreshold: 80,
        liquidationBonus: 500,
        borrowFactor: 100,
        availableAmountRaw: "1000000000", // 1000 tokens
        borrowedAmountSfRaw: "100000000000000000000000000", // 100 tokens * 1e18
        cumulativeBorrowRateBsfRaw: "1000000000000000000",
        collateralMintTotalSupplyRaw: "1200000000", // 1200 collateral tokens
        scopePriceChain: null,
      });

      vi.spyOn(decoder, "setReserveMintCache");

      const cache = await loadReserves(mockConnection, marketPubkey);

      const entry = cache.get("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      expect(entry).toBeDefined();
      
      // exchangeRate = 1200 / 1100 = 1.0909...
      expect(entry!.collateralExchangeRateUi).toBeCloseTo(1.0909, 4);
    });
  });

  describe("Allowlist Filtering", () => {
    it("should filter reserves by allowlisted liquidity mints", async () => {
      // Setup: Mock 3 reserves with different liquidity mints
      const reserve1Pubkey = new PublicKey("d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q");
      const reserve2Pubkey = new PublicKey("FRYBbRFXJ2fKJZ6q5jCQvK5c7cRZNP1jVcSPP6NEupXo");
      const reserve3Pubkey = new PublicKey("5sXbXn4dFHqCxLKj5ZPyEXV2C8VdBLqhVJjqDy2X4DnD");
      
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const OTHER_MINT = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E"; // BTC mint
      
      mockConnection.getProgramAccounts = vi.fn().mockResolvedValue([
        { pubkey: reserve1Pubkey, account: {} },
        { pubkey: reserve2Pubkey, account: {} },
        { pubkey: reserve3Pubkey, account: {} },
      ]);

      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: Buffer.alloc(100) },
        { data: Buffer.alloc(100) },
        { data: Buffer.alloc(100) },
      ]);

      vi.spyOn(discriminator, "anchorDiscriminator").mockReturnValue(
        Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
      );

      // Mock decodeReserve to return SOL, USDC, and BTC reserves
      vi.spyOn(decoder, "decodeReserve").mockImplementation((_data, pubkey) => {
        let mint, collateral;
        if (pubkey.equals(reserve1Pubkey)) {
          mint = SOL_MINT;
          collateral = "collateral_sol";
        } else if (pubkey.equals(reserve2Pubkey)) {
          mint = USDC_MINT;
          collateral = "collateral_usdc";
        } else {
          mint = OTHER_MINT;
          collateral = "collateral_btc";
        }
        
        return {
          reservePubkey: pubkey.toString(),
          marketPubkey: marketPubkey.toString(),
          liquidityMint: mint,
          collateralMint: collateral,
          liquidityDecimals: 6,
          collateralDecimals: 6,
          oraclePubkeys: [],
          loanToValueRatio: 75,
          liquidationThreshold: 80,
          liquidationBonus: 500,
          borrowFactor: 100,
          availableAmountRaw: "1000000000",
          borrowedAmountSfRaw: "100000000000000000000000000",
          cumulativeBorrowRateBsfRaw: "1000000000000000000",
          collateralMintTotalSupplyRaw: "1000000000",
          scopePriceChain: null,
        };
      });

      vi.spyOn(decoder, "setReserveMintCache");

      // Execute with SOL+USDC allowlist
      const allowlist = new Set([SOL_MINT, USDC_MINT]);
      const cache = await loadReserves(mockConnection, marketPubkey, allowlist);

      // Verify only SOL and USDC reserves are cached
      // Each reserve creates 2 entries (liquidity + collateral), so 2 reserves × 2 = 4 entries
      expect(cache.size).toBe(4);
      expect(cache.has(SOL_MINT)).toBe(true);
      expect(cache.has(USDC_MINT)).toBe(true);
      expect(cache.has(OTHER_MINT)).toBe(false); // BTC should be filtered out
      
      // Verify setReserveMintCache was only called for SOL and USDC
      expect(decoder.setReserveMintCache).toHaveBeenCalledTimes(2);
    });

    it("should load all reserves when no allowlist is provided", async () => {
      const reserve1Pubkey = new PublicKey("d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q");
      const reserve2Pubkey = new PublicKey("FRYBbRFXJ2fKJZ6q5jCQvK5c7cRZNP1jVcSPP6NEupXo");
      
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

      vi.spyOn(decoder, "decodeReserve").mockImplementation((_data, pubkey) => ({
        reservePubkey: pubkey.toString(),
        marketPubkey: marketPubkey.toString(),
        liquidityMint: `mint-${pubkey.toString().slice(0, 8)}`,
        collateralMint: `collateral-${pubkey.toString().slice(0, 8)}`,
        liquidityDecimals: 6,
        collateralDecimals: 6,
        oraclePubkeys: [],
        loanToValueRatio: 75,
        liquidationThreshold: 80,
        liquidationBonus: 500,
        borrowFactor: 100,
        availableAmountRaw: "1000000000",
        borrowedAmountSfRaw: "100000000000000000000000000",
        cumulativeBorrowRateBsfRaw: "1000000000000000000",
        collateralMintTotalSupplyRaw: "1000000000",
        scopePriceChain: null,
      }));

      vi.spyOn(decoder, "setReserveMintCache");

      // Execute without allowlist
      const cache = await loadReserves(mockConnection, marketPubkey);

      // All reserves should be loaded: 2 reserves × 2 keys = 4 entries
      expect(cache.size).toBe(4);
      expect(decoder.setReserveMintCache).toHaveBeenCalledTimes(2);
    });
  });
});
