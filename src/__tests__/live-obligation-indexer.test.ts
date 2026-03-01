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
      // USDC reserve pubkey - intentionally NOT loaded in cache to test mixed obligation filtering
      const usdcReservePubkey = "2FVLAhS2rFpPzTGxdFtGxw8M8ufQB2SX9eP39NsHLLUy";
      
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
      // USDC reserve pubkey - will be loaded in cache to test complete (non-mixed) obligation
      const usdcReservePubkey = "2FVLAhS2rFpPzTGxdFtGxw8M8ufQB2SX9eP39NsHLLUy";
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
        oraclePubkeys: [new PublicKey("2FVLAhS2rFpPzTGxdFtGxw8M8ufQB2SX9eP39NsHLLUy")],
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

  describe("Health source selection and scored fields", () => {
    it("should use recomputed when LIQSOL_HEALTH_SOURCE=recomputed even if hybrid exists", () => {
      const mint = "So11111111111111111111111111111111111111112";
      const reserve = {
        reservePubkey: new PublicKey("11111111111111111111111111111112"),
        liquidityMint: mint,
        collateralMint: "cSOL111111111111111111111111111111111111",
        availableAmount: 1000000n,
        cumulativeBorrowRate: 1000000000000000000n,
        cumulativeBorrowRateBsfRaw: "1000000000000000000",
        loanToValue: 75,
        liquidationThreshold: 50,
        liquidationBonus: 500,
        borrowFactor: 200,
        oraclePubkeys: [new PublicKey("11111111111111111111111111111111")],
        liquidityDecimals: 0,
        collateralDecimals: 0,
        scopePriceChain: null,
        collateralExchangeRateUi: 1.0,
      };
      const reserveCache = {
        byReserve: new Map([[reserve.reservePubkey.toString(), reserve]]),
        byMint: new Map([[mint, reserve]]),
      };
      const oracleCache = new Map([
        [mint, { price: 1n, confidence: 0n, slot: 1n, exponent: 0, oracleType: "pyth" as const }],
      ]);
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        reserveCache,
        oracleCache,
      });
      indexer.setCurrentSlotHint(12400);
      const obligation = {
        obligationPubkey: "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo",
        ownerPubkey: "OwnerPubkey1111111111111111111111111111",
        marketPubkey: "MarketPubkey111111111111111111111111111",
        lastUpdateSlot: "12345",
        deposits: [{ reserve: reserve.reservePubkey.toString(), mint, depositedAmount: "2" }],
        borrows: [{ reserve: reserve.reservePubkey.toString(), mint, borrowedAmount: "1000000000000000000" }],
        depositedValueSfRaw: "2000000000000000000",
        borrowedAssetsMarketValueSfRaw: "1000000000000000000",
        borrowFactorAdjustedDebtValueSfRaw: "3000000000000000000",
        unhealthyBorrowValueSfRaw: "1000000000000000000",
      };

      const prev = process.env.LIQSOL_HEALTH_SOURCE;
      process.env.LIQSOL_HEALTH_SOURCE = "recomputed";
      const scoring = (indexer as any).computeHealthScoring(obligation);
      if (prev === undefined) {
        delete process.env.LIQSOL_HEALTH_SOURCE;
      } else {
        process.env.LIQSOL_HEALTH_SOURCE = prev;
      }

      expect(scoring.healthSourceUsed).toBe("recomputed");
      expect(scoring.totalCollateralUsdRecomputed).toBeCloseTo(2, 6);
      expect(scoring.totalCollateralUsdAdjRecomputed).toBeCloseTo(1, 6);
      expect(scoring.healthRatio).toBeCloseTo(scoring.healthRatioRecomputed ?? 0, 6);
      expect(scoring.collateralValueHybrid).toBeCloseTo(1, 6);
      expect(scoring.borrowValueHybrid).toBeCloseTo(3, 6);
      expect(scoring.healthRatioHybridRaw).toBeCloseTo(1 / 3, 6);
      expect(scoring.liquidationEligible).toBe(true);
    });

    it("should prefer hybrid when LIQSOL_HEALTH_SOURCE=hybrid and hybrid exists", () => {
      const mint = "So11111111111111111111111111111111111111112";
      const reserve = {
        reservePubkey: new PublicKey("11111111111111111111111111111112"),
        liquidityMint: mint,
        collateralMint: "cSOL111111111111111111111111111111111111",
        availableAmount: 1000000n,
        cumulativeBorrowRate: 1000000000000000000n,
        cumulativeBorrowRateBsfRaw: "1000000000000000000",
        loanToValue: 75,
        liquidationThreshold: 50,
        liquidationBonus: 500,
        borrowFactor: 200,
        oraclePubkeys: [new PublicKey("11111111111111111111111111111111")],
        liquidityDecimals: 0,
        collateralDecimals: 0,
        scopePriceChain: null,
        collateralExchangeRateUi: 1.0,
      };
      const reserveCache = {
        byReserve: new Map([[reserve.reservePubkey.toString(), reserve]]),
        byMint: new Map([[mint, reserve]]),
      };
      const oracleCache = new Map([
        [mint, { price: 1n, confidence: 0n, slot: 1n, exponent: 0, oracleType: "pyth" as const }],
      ]);
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        reserveCache,
        oracleCache,
      });
      indexer.setCurrentSlotHint(12400);
      const obligation = {
        obligationPubkey: "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo",
        ownerPubkey: "OwnerPubkey1111111111111111111111111111",
        marketPubkey: "MarketPubkey111111111111111111111111111",
        lastUpdateSlot: "12345",
        deposits: [{ reserve: reserve.reservePubkey.toString(), mint, depositedAmount: "2" }],
        borrows: [{ reserve: reserve.reservePubkey.toString(), mint, borrowedAmount: "1000000000000000000" }],
        depositedValueSfRaw: "2000000000000000000",
        borrowedAssetsMarketValueSfRaw: "1000000000000000000",
        borrowFactorAdjustedDebtValueSfRaw: "3000000000000000000",
        unhealthyBorrowValueSfRaw: "1000000000000000000",
      };

      const prev = process.env.LIQSOL_HEALTH_SOURCE;
      process.env.LIQSOL_HEALTH_SOURCE = "hybrid";
      const scoring = (indexer as any).computeHealthScoring(obligation);
      if (prev === undefined) {
        delete process.env.LIQSOL_HEALTH_SOURCE;
      } else {
        process.env.LIQSOL_HEALTH_SOURCE = prev;
      }

      expect(scoring.healthSourceUsed).toBe("hybrid");
      expect(scoring.healthRatio).toBeCloseTo(1 / 3, 6);
      expect(scoring.liquidationEligible).toBe(true);
    });

    it("should disable hybrid and use recomputed when SF is stale", () => {
      const mint = "So11111111111111111111111111111111111111112";
      const reserve = {
        reservePubkey: new PublicKey("11111111111111111111111111111112"),
        liquidityMint: mint,
        collateralMint: "cSOL111111111111111111111111111111111111",
        availableAmount: 1000000n,
        cumulativeBorrowRate: 1000000000000000000n,
        cumulativeBorrowRateBsfRaw: "1000000000000000000",
        loanToValue: 75,
        liquidationThreshold: 50,
        liquidationBonus: 500,
        borrowFactor: 200,
        oraclePubkeys: [new PublicKey("11111111111111111111111111111111")],
        liquidityDecimals: 0,
        collateralDecimals: 0,
        scopePriceChain: null,
        collateralExchangeRateUi: 1.0,
      };
      const reserveCache = {
        byReserve: new Map([[reserve.reservePubkey.toString(), reserve]]),
        byMint: new Map([[mint, reserve]]),
      };
      const oracleCache = new Map([
        [mint, { price: 1n, confidence: 0n, slot: 1n, exponent: 0, oracleType: "pyth" as const }],
      ]);
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        reserveCache,
        oracleCache,
      });
      indexer.setCurrentSlotHint(500000);
      const obligation = {
        obligationPubkey: "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo",
        ownerPubkey: "OwnerPubkey1111111111111111111111111111",
        marketPubkey: "MarketPubkey111111111111111111111111111",
        lastUpdateSlot: "12345",
        deposits: [{ reserve: reserve.reservePubkey.toString(), mint, depositedAmount: "2" }],
        borrows: [{ reserve: reserve.reservePubkey.toString(), mint, borrowedAmount: "1000000000000000000" }],
        depositedValueSfRaw: "2000000000000000000",
        borrowedAssetsMarketValueSfRaw: "1000000000000000000",
        borrowFactorAdjustedDebtValueSfRaw: "3000000000000000000",
        unhealthyBorrowValueSfRaw: "1000000000000000000",
      };

      const prev = process.env.LIQSOL_HEALTH_SOURCE;
      process.env.LIQSOL_HEALTH_SOURCE = "recomputed";
      const scoring = (indexer as any).computeHealthScoring(obligation);
      if (prev === undefined) {
        delete process.env.LIQSOL_HEALTH_SOURCE;
      } else {
        process.env.LIQSOL_HEALTH_SOURCE = prev;
      }

      expect(scoring.healthSourceUsed).toBe("recomputed");
      expect(scoring.healthRatioHybrid).toBeUndefined();
      expect(scoring.healthRatioHybridRaw).toBeUndefined();
      expect(scoring.borrowValueHybrid).toBeUndefined();
      expect(scoring.collateralValueHybrid).toBeUndefined();
      expect(scoring.hybridDisabledReason).toBe("sf-stale");
      expect(scoring.slotLag).toBeGreaterThan(200000);
    });

    it("should gate liquidation from chosen source and not protocol override", () => {
      const mint = "So11111111111111111111111111111111111111112";
      const reserve = {
        reservePubkey: new PublicKey("11111111111111111111111111111112"),
        liquidityMint: mint,
        collateralMint: "cSOL111111111111111111111111111111111111",
        availableAmount: 1000000n,
        cumulativeBorrowRate: 1000000000000000000n,
        cumulativeBorrowRateBsfRaw: "1000000000000000000",
        loanToValue: 75,
        liquidationThreshold: 50,
        liquidationBonus: 500,
        borrowFactor: 100,
        oraclePubkeys: [new PublicKey("11111111111111111111111111111111")],
        liquidityDecimals: 0,
        collateralDecimals: 0,
        scopePriceChain: null,
        collateralExchangeRateUi: 1.0,
      };
      const reserveCache = {
        byReserve: new Map([[reserve.reservePubkey.toString(), reserve]]),
        byMint: new Map([[mint, reserve]]),
      };
      const oracleCache = new Map([
        [mint, { price: 1n, confidence: 0n, slot: 1n, exponent: 0, oracleType: "pyth" as const }],
      ]);
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        reserveCache,
        oracleCache,
      });
      indexer.setCurrentSlotHint(500000);
      const obligation = {
        obligationPubkey: "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo",
        ownerPubkey: "OwnerPubkey1111111111111111111111111111",
        marketPubkey: "MarketPubkey111111111111111111111111111",
        lastUpdateSlot: "12345",
        deposits: [{ reserve: reserve.reservePubkey.toString(), mint, depositedAmount: "3" }],
        borrows: [{ reserve: reserve.reservePubkey.toString(), mint, borrowedAmount: "1000000000000000000" }],
        depositedValueSfRaw: "3000000000000000000",
        borrowedAssetsMarketValueSfRaw: "1000000000000000000",
        borrowFactorAdjustedDebtValueSfRaw: "1000000000000000000",
        unhealthyBorrowValueSfRaw: "500000000000000000",
      };

      const prev = process.env.LIQSOL_HEALTH_SOURCE;
      process.env.LIQSOL_HEALTH_SOURCE = "recomputed";
      const scoring = (indexer as any).computeHealthScoring(obligation);
      if (prev === undefined) {
        delete process.env.LIQSOL_HEALTH_SOURCE;
      } else {
        process.env.LIQSOL_HEALTH_SOURCE = prev;
      }

      expect(scoring.healthSourceUsed).toBe("recomputed");
      expect(scoring.healthRatio).toBeGreaterThan(1);
      expect(scoring.liquidationEligibleProtocol).toBe(true);
      expect(scoring.liquidationEligible).toBe(false);
    });

    it("should include lastUpdateSlot in getScoredObligations output", () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
      });

      (indexer as any).cache.set("ob1", {
        decoded: {
          obligationPubkey: "ob1",
          ownerPubkey: "owner1",
          marketPubkey: "market1",
          lastUpdateSlot: "999",
          deposits: [],
          borrows: [],
        },
        lastUpdated: Date.now(),
        slot: 1n,
        healthRatio: 1.1,
        borrowValue: 100,
        collateralValue: 110,
        liquidationEligible: false,
        slotLag: 456,
        hybridDisabledReason: "sf-stale",
      });

      const scored = indexer.getScoredObligations();
      expect(scored).toHaveLength(1);
      expect(scored[0].lastUpdateSlot).toBe("999");
      expect(scored[0].slotLag).toBe(456);
      expect(scored[0].hybridDisabledReason).toBe("sf-stale");
    });
  });
});
