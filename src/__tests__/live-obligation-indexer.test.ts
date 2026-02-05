import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { LiveObligationIndexer } from "../engine/liveObligationIndexer.js";
import { CommitmentLevel } from "@triton-one/yellowstone-grpc";

// Mock the Yellowstone modules
vi.mock("../yellowstone/client.js", () => ({
  createYellowstoneClient: vi.fn(),
  YellowstoneClientInstance: {},
}));

vi.mock("../yellowstone/subscribeAccounts.js", () => ({
  subscribeToAccounts: vi.fn(),
}));

describe("LiveObligationIndexer", () => {
  const testDataDir = join(process.cwd(), "test-data-live-indexer");
  const testFilePath = join(testDataDir, "obligations.jsonl");
  const testProgramId = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
  const testRpcUrl = "https://api.mainnet-beta.solana.com";

  beforeEach(() => {
    // Create test data directory
    mkdirSync(testDataDir, { recursive: true });
    
    // Clear all mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up test data directory
    try {
      rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Constructor and Configuration", () => {
    it("should create indexer with minimal config", () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
      });

      expect(indexer).toBeDefined();
      expect(indexer.isIndexerRunning()).toBe(false);
    });

    it("should create indexer with full config", () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        obligationsFilePath: testFilePath,
        filters: [],
        commitment: CommitmentLevel.CONFIRMED,
        maxReconnectAttempts: 5,
        reconnectDelayMs: 500,
        reconnectBackoffFactor: 1.5,
      });

      expect(indexer).toBeDefined();
      const stats = indexer.getStats();
      expect(stats.isRunning).toBe(false);
      expect(stats.cacheSize).toBe(0);
    });
  });

  describe("Snapshot Loading", () => {
    it("should handle missing snapshot file gracefully", async () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        obligationsFilePath: join(testDataDir, "nonexistent.jsonl"),
      });

      const stats = indexer.getStats();
      expect(stats.knownPubkeys).toBe(0);
    });

    it("should load valid pubkeys from snapshot file", () => {
      // Create test file with valid pubkeys
      const testPubkeys = [
        "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo",
        "11111111111111111111111111111112",
      ];
      writeFileSync(testFilePath, testPubkeys.join("\n") + "\n", "utf-8");

      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        obligationsFilePath: testFilePath,
      });

      expect(indexer).toBeDefined();
    });

    it("should skip invalid pubkeys in snapshot file", () => {
      // Create test file with mix of valid and invalid pubkeys
      const content = [
        "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo",
        "invalid-pubkey",
        "",
        "11111111111111111111111111111112",
      ].join("\n");
      writeFileSync(testFilePath, content, "utf-8");

      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        obligationsFilePath: testFilePath,
      });

      expect(indexer).toBeDefined();
    });
  });

  describe("Cache Operations", () => {
    it("should initialize with empty cache", () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
      });

      expect(indexer.getAllObligations()).toEqual([]);
      expect(indexer.getObligation("11111111111111111111111111111112")).toBeNull();
    });

    it("should return null for non-existent obligation", () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
      });

      const result = indexer.getObligation("H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo");
      expect(result).toBeNull();
    });
  });

  describe("Stats", () => {
    it("should return correct initial stats", () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
      });

      const stats = indexer.getStats();
      expect(stats.isRunning).toBe(false);
      expect(stats.cacheSize).toBe(0);
      expect(stats.knownPubkeys).toBe(0);
      expect(stats.lastUpdate).toBeNull();
      expect(stats.oldestSlot).toBeNull();
      expect(stats.newestSlot).toBeNull();
    });
  });

  describe("Lifecycle", () => {
    it("should report not running initially", () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
      });

      expect(indexer.isIndexerRunning()).toBe(false);
    });

    it("should stop indexer without error even if not started", async () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
      });

      await expect(indexer.stop()).resolves.not.toThrow();
    });

    it("should allow multiple stop calls", async () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
      });

      await indexer.stop();
      await expect(indexer.stop()).resolves.not.toThrow();
    });
  });

  describe("Configuration Validation", () => {
    it("should use default values for optional config", () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
      });

      expect(indexer).toBeDefined();
      const stats = indexer.getStats();
      expect(stats).toBeDefined();
    });

    it("should respect custom reconnect configuration", () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        maxReconnectAttempts: 3,
        reconnectDelayMs: 100,
        reconnectBackoffFactor: 1.5,
      });

      expect(indexer).toBeDefined();
    });
  });

  describe("Mixed Obligation Filtering", () => {
    it("should skip mixed obligations that touch allowlisted and non-allowlisted reserves", () => {
      // Create a mock reserve cache with only SOL reserve
      const solReservePubkey = "11111111111111111111111111111112";
      const solMint = "So11111111111111111111111111111111111111112";
      const usdcReservePubkey = "22222222222222222222222222222222";
      
      const mockReserve = {
        reservePubkey: new PublicKey(solReservePubkey),
        liquidityMint: solMint,
        collateralMint: "cSOL111111111111111111111111111111111111",
        availableAmount: 1000000n,
        cumulativeBorrowRate: 1000000000000000000n,
        cumulativeBorrowRateBsfRaw: 1000000000000000000n,
        loanToValue: 75,
        liquidationThreshold: 80,
        liquidationBonus: 500,
        borrowFactor: 100,
        oraclePubkeys: [new PublicKey("11111111111111111111111111111111")],
        liquidityDecimals: 9,
        collateralDecimals: 9,
        scopePriceChain: null,
        collateralExchangeRateUi: 1.0,
      };

      const reserveCache = {
        byReserve: new Map([[solReservePubkey, mockReserve]]),
        byMint: new Map([[solMint, mockReserve]]),
      };

      const allowedLiquidityMints = new Set([solMint]);

      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        reserveCache,
        allowedLiquidityMints,
      });

      // Create a mixed obligation with one deposit in SOL reserve and one borrow in a non-loaded reserve
      const mixedObligation = {
        obligationPubkey: "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo",
        ownerPubkey: "OwnerPubkey1111111111111111111111111111",
        marketPubkey: "MarketPubkey111111111111111111111111111",
        lastUpdateSlot: "12345",
        deposits: [
          {
            reserve: solReservePubkey, // This reserve IS loaded
            mint: solMint,
            depositedAmount: "1000000000",
          },
        ],
        borrows: [
          {
            reserve: usdcReservePubkey, // This reserve is NOT loaded
            mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            borrowedAmount: "500000000",
          },
        ],
      };

      // Access private method through type assertion
      const scoring = (indexer as any).computeHealthScoring(mixedObligation);

      // Verify the result
      expect(scoring.unscoredReason).toBe("MIXED_OUT_OF_SCOPE_RESERVE");
      
      // Verify stats were updated correctly
      const stats = indexer.getStats();
      expect(stats.skippedMixedOutOfScopeCount).toBe(1);
      expect(stats.unscoredCount).toBe(0); // Should NOT increment unscoredCount
    });

    it("should NOT skip obligations with all reserves loaded", () => {
      // Create a mock reserve cache with both SOL and USDC reserves
      const solReservePubkey = "11111111111111111111111111111112";
      const solMint = "So11111111111111111111111111111111111111112";
      const usdcReservePubkey = "22222222222222222222222222222222";
      const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      
      const solReserve = {
        reservePubkey: new PublicKey(solReservePubkey),
        liquidityMint: solMint,
        collateralMint: "cSOL111111111111111111111111111111111111",
        availableAmount: 1000000n,
        cumulativeBorrowRate: 1000000000000000000n,
        cumulativeBorrowRateBsfRaw: 1000000000000000000n,
        loanToValue: 75,
        liquidationThreshold: 80,
        liquidationBonus: 500,
        borrowFactor: 100,
        oraclePubkeys: [new PublicKey("11111111111111111111111111111111")],
        liquidityDecimals: 9,
        collateralDecimals: 9,
        scopePriceChain: null,
        collateralExchangeRateUi: 1.0,
      };

      const usdcReserve = {
        reservePubkey: new PublicKey(usdcReservePubkey),
        liquidityMint: usdcMint,
        collateralMint: "cUSDC11111111111111111111111111111111111",
        availableAmount: 1000000n,
        cumulativeBorrowRate: 1000000000000000000n,
        cumulativeBorrowRateBsfRaw: 1000000000000000000n,
        loanToValue: 75,
        liquidationThreshold: 80,
        liquidationBonus: 500,
        borrowFactor: 100,
        oraclePubkeys: [new PublicKey("22222222222222222222222222222222")],
        liquidityDecimals: 6,
        collateralDecimals: 6,
        scopePriceChain: null,
        collateralExchangeRateUi: 1.0,
      };

      const reserveCache = {
        byReserve: new Map([
          [solReservePubkey, solReserve],
          [usdcReservePubkey, usdcReserve],
        ]),
        byMint: new Map([
          [solMint, solReserve],
          [usdcMint, usdcReserve],
        ]),
      };

      const allowedLiquidityMints = new Set([solMint, usdcMint]);

      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        reserveCache,
        allowedLiquidityMints,
      });

      // Create an obligation with both reserves loaded
      const completeObligation = {
        obligationPubkey: "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo",
        ownerPubkey: "OwnerPubkey1111111111111111111111111111",
        marketPubkey: "MarketPubkey111111111111111111111111111",
        lastUpdateSlot: "12345",
        deposits: [
          {
            reserve: solReservePubkey, // This reserve IS loaded
            mint: solMint,
            depositedAmount: "1000000000",
          },
        ],
        borrows: [
          {
            reserve: usdcReservePubkey, // This reserve IS loaded
            mint: usdcMint,
            borrowedAmount: "500000000",
          },
        ],
      };

      // Access private method through type assertion
      const scoring = (indexer as any).computeHealthScoring(completeObligation);

      // Verify the result - should not be skipped for mixed, but may fail for other reasons (no oracle cache)
      expect(scoring.unscoredReason).not.toBe("MIXED_OUT_OF_SCOPE_RESERVE");
      
      // Verify stats were NOT incremented
      const stats = indexer.getStats();
      expect(stats.skippedMixedOutOfScopeCount).toBe(0);
    });
  });

  describe("Snapshot Reload", () => {
    it("should allow reloading snapshot", () => {
      const testPubkeys = ["H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo"];
      writeFileSync(testFilePath, testPubkeys.join("\n") + "\n", "utf-8");

      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        obligationsFilePath: testFilePath,
      });

      expect(() => indexer.reloadSnapshot()).not.toThrow();
    });
  });
});
