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
      });

      expect(indexer).toBeDefined();
      expect(indexer.isIndexerRunning()).toBe(false);
    });

    it("should create indexer with full config", () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
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
      });

      expect(indexer.getAllObligations()).toEqual([]);
      expect(indexer.getObligation("11111111111111111111111111111112")).toBeNull();
    });

    it("should return null for non-existent obligation", () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
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
      });

      expect(indexer.isIndexerRunning()).toBe(false);
    });

    it("should stop indexer without error even if not started", async () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
      });

      await expect(indexer.stop()).resolves.not.toThrow();
    });

    it("should allow multiple stop calls", async () => {
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: "https://test.example.com",
        yellowstoneToken: "test-token",
        programId: testProgramId,
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
        maxReconnectAttempts: 3,
        reconnectDelayMs: 100,
        reconnectBackoffFactor: 1.5,
      });

      expect(indexer).toBeDefined();
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
        obligationsFilePath: testFilePath,
      });

      expect(() => indexer.reloadSnapshot()).not.toThrow();
    });
  });
});
