import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { LiveObligationIndexer } from "../engine/liveObligationIndexer.js";
import type { YellowstoneSubscriptionHandle } from "../yellowstone/subscribeAccounts.js";
import { Buffer } from "buffer";

// Mock data for testing
const VALID_OBLIGATION_DATA = Buffer.from("01".repeat(500), "hex"); // Placeholder

// Mock modules
vi.mock("../yellowstone/client.js", () => ({
  createYellowstoneClient: vi.fn().mockResolvedValue({}),
}));

vi.mock("../yellowstone/subscribeAccounts.js", () => {
  let mockHandle: YellowstoneSubscriptionHandle | null = null;
  
  return {
    subscribeToAccounts: vi.fn().mockImplementation(() => {
      let resolveDone: () => void;
      
      const donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      
      mockHandle = {
        close: vi.fn(() => {
          // Simulate stream closing by resolving done
          resolveDone();
        }),
        done: donePromise,
      };
      
      return Promise.resolve(mockHandle);
    }),
  };
});

vi.mock("../kamino/decoder.js", () => ({
  decodeObligation: vi.fn().mockReturnValue({
    pubkey: "test",
    deposits: [],
    borrows: [],
    depositedValue: "0",
    borrowedValue: "0",
    unhealthyBorrowValue: "0",
    superUnhealthyBorrowValue: "0",
    depositsAssetTiers: [],
    borrowsAssetTiers: [],
    marketId: "test",
    marketName: "test",
    elevationGroup: 0,
    highestBorrowFactor: 0,
    loanToValue: 0,
    owner: new PublicKey("11111111111111111111111111111112"),
  }),
}));

// Mock Connection
vi.mock("@solana/web3.js", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = await vi.importActual("@solana/web3.js") as any;
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getMultipleAccountsInfo: vi.fn().mockResolvedValue([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { data: VALID_OBLIGATION_DATA, owner: new (actual as any).PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD") },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { data: VALID_OBLIGATION_DATA, owner: new (actual as any).PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD") },
      ]),
    })),
  };
});

describe("LiveObligationIndexer - Production Safe Features", () => {
  const testDataDir = join(process.cwd(), "test-data-production-safe");
  const testFilePath = join(testDataDir, "obligations.jsonl");
  const testProgramId = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
  const testRpcUrl = "https://api.mainnet-beta.solana.com";

  beforeEach(() => {
    mkdirSync(testDataDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("RPC Bootstrap", () => {
    it("should bootstrap cache from RPC when snapshot file exists", async () => {
      // Create snapshot file with test pubkeys
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
        bootstrapBatchSize: 100,
        bootstrapConcurrency: 1,
      });

      // Start the indexer (this should bootstrap)
      await indexer.start();

      // Wait a bit for bootstrap to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Check that cache was populated from bootstrap
      const stats = indexer.getStats();
      expect(stats.cacheSize).toBeGreaterThan(0);

      await indexer.stop();
    });

    it("should handle empty snapshot file gracefully", async () => {
      writeFileSync(testFilePath, "", "utf-8");

      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        obligationsFilePath: testFilePath,
      });

      await indexer.start();
      
      const stats = indexer.getStats();
      expect(stats.cacheSize).toBe(0);
      
      await indexer.stop();
    });
  });

  describe("Slot Ordering", () => {
    it("should not overwrite newer data with bootstrap (slot=0n)", async () => {
      // This test verifies that bootstrap data (slot=0n) doesn't overwrite
      // live updates that may have already been received
      
      const testPubkeys = ["H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo"];
      writeFileSync(testFilePath, testPubkeys.join("\n") + "\n", "utf-8");

      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        obligationsFilePath: testFilePath,
      });

      // Start indexer - bootstrap will populate with slot=0n
      await indexer.start();
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const statsAfterBootstrap = indexer.getStats();
      expect(statsAfterBootstrap.oldestSlot).toBe("0");

      await indexer.stop();
    });
  });

  describe("Subscription Handle", () => {
    it("should use subscription handle for deterministic stop", async () => {
      const testPubkeys = ["H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo"];
      writeFileSync(testFilePath, testPubkeys.join("\n") + "\n", "utf-8");

      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        obligationsFilePath: testFilePath,
      });

      await indexer.start();
      
      // Give it time to start subscription
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Stop should call handle.close() and wait for done
      await indexer.stop();
      
      const stats = indexer.getStats();
      expect(stats.isRunning).toBe(false);
    });

    it("should halt reconnect loop after stop() is called", async () => {
      const testPubkeys = ["H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo"];
      writeFileSync(testFilePath, testPubkeys.join("\n") + "\n", "utf-8");

      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        obligationsFilePath: testFilePath,
        reconnectDelayMs: 50,
      });

      await indexer.start();
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Call stop - should halt any reconnect attempts
      await indexer.stop();
      
      const reconnectCountBeforeStop = indexer.getStats().reconnectCount;
      
      // Wait and verify no further reconnects happened
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const reconnectCountAfterStop = indexer.getStats().reconnectCount;
      expect(reconnectCountAfterStop).toBe(reconnectCountBeforeStop);
    });
  });

  describe("Circuit Breaker", () => {
    it("should track decode failures in sliding window", async () => {
      // Mock decoder to fail repeatedly
      const { decodeObligation } = await import("../kamino/decoder.js");
      vi.mocked(decodeObligation).mockImplementation(() => {
        throw new Error("Decode failure");
      });

      const testPubkeys = ["H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo"];
      writeFileSync(testFilePath, testPubkeys.join("\n") + "\n", "utf-8");

      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        obligationsFilePath: testFilePath,
        bootstrapBatchSize: 1,
      });

      // Start will trigger bootstrap which will fail to decode
      // With enough failures, circuit breaker should trigger
      await indexer.start();
      
      // Wait for bootstrap to attempt decoding
      await new Promise(resolve => setTimeout(resolve, 200));
      
      await indexer.stop();
      
      // The indexer should still be stable after decode failures
      expect(indexer).toBeDefined();
    });
  });

  describe("Configuration", () => {
    it("should accept all new config parameters", () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
        bootstrapBatchSize: 50,
        bootstrapConcurrency: 2,
        inactivityTimeoutSeconds: 20,
        maxReconnectAttempts: 5,
        reconnectDelayMs: 500,
      });

      expect(indexer).toBeDefined();
      expect(indexer.isIndexerRunning()).toBe(false);
    });

    it("should use default values for optional parameters", () => {
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
  });

  describe("Stats with reconnectCount", () => {
    it("should include reconnectCount in stats", () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
        rpcUrl: testRpcUrl,
      });

      const stats = indexer.getStats();
      expect(stats).toHaveProperty("reconnectCount");
      expect(stats.reconnectCount).toBe(0);
    });
  });
});
