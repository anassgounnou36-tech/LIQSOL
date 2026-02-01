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

describe("Oracle Cache Tests", () => {
  let mockConnection: Connection;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnection = {} as Connection;
  });

  describe("loadOracles", () => {
    it.todo("should load oracle data for all reserves", async () => {
      const mint1 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const mint2 = "So11111111111111111111111111111111111111112";
      const oracle1 = new PublicKey(
        "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"
      );
      const oracle2 = new PublicKey(
        "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo"
      );

      // Create mock reserve cache
      const reserveCache: ReserveCache = new Map([
        [
          mint1,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            scopePriceChain: null,
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oracle1],
          },
        ],
        [
          mint2,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 10000000n,
            cumulativeBorrowRate: 0n,
            scopePriceChain: null,
            loanToValue: 70,
            liquidationThreshold: 75,
            liquidationBonus: 450,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oracle2],
          },
        ],
      ]);

      // Mock Pyth price account data for oracle1
      const pythData = Buffer.alloc(3500);
      // Magic: 0xa1b2c3d4 at offset 0
      pythData.writeUInt32LE(0xa1b2c3d4, 0);
      // Version: 2 at offset 4
      pythData.writeUInt32LE(2, 4);
      // Type: 3 (price account) at offset 8
      pythData.writeUInt32LE(3, 8);
      // Exponent: -8 at offset 20
      pythData.writeInt32LE(-8, 20);
      // Timestamp at offset 104 - use current time to avoid staleness
      const currentTimestamp = Math.floor(Date.now() / 1000);
      pythData.writeBigInt64LE(BigInt(currentTimestamp), 104);
      // Price: 100000000 (1 USD with -8 exponent) at offset 208
      pythData.writeBigInt64LE(100000000n, 208);
      // Confidence: 50000 at offset 216
      pythData.writeBigUInt64LE(50000n, 216);
      // Status: 1 (trading) at offset 224
      pythData.writeUInt32LE(1, 224);

      // Mock Switchboard data for oracle2
      const switchboardData = Buffer.alloc(500);
      // Mantissa at offset 217
      switchboardData.writeBigInt64LE(200000000n, 217);
      // Scale at offset 225
      switchboardData.writeUInt32LE(8, 225);
      // Std dev at offset 249
      switchboardData.writeBigInt64LE(100000n, 249);
      // Last update at offset 129 - use current time to avoid staleness
      switchboardData.writeBigInt64LE(BigInt(currentTimestamp), 129);

      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: pythData, owner: new PublicKey("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH") },
        { data: switchboardData, owner: new PublicKey("SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f") },
      ]);

      // Execute
      const cache = await loadOracles(mockConnection, reserveCache);

      // Verify
      expect(mockConnection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
      expect(cache.size).toBe(2);

      // Verify Pyth oracle (oracle1 -> mint1)
      const price1 = cache.get(mint1);
      expect(price1).toBeDefined();
      expect(price1!.price).toBe(100000000n);
      expect(price1!.confidence).toBe(50000n);
      expect(price1!.exponent).toBe(-8);
      expect(price1!.oracleType).toBe("pyth");

      // Verify Switchboard oracle (oracle2 -> mint2)
      const price2 = cache.get(mint2);
      expect(price2).toBeDefined();
      expect(price2!.price).toBe(200000000n);
      expect(price2!.confidence).toBe(100000n);
      expect(price2!.exponent).toBe(-8);
      expect(price2!.oracleType).toBe("switchboard");
    });

    it("should handle empty reserve cache", async () => {
      const reserveCache: ReserveCache = new Map();
      mockConnection.getMultipleAccountsInfo = vi.fn();

      const cache = await loadOracles(mockConnection, reserveCache);

      expect(cache.size).toBe(0);
      expect(mockConnection.getMultipleAccountsInfo).not.toHaveBeenCalled();
    });

    it("should handle null oracle account data", async () => {
      const mint1 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const oracle1 = new PublicKey(
        "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"
      );

      const reserveCache: ReserveCache = new Map([
        [
          mint1,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            scopePriceChain: null,
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oracle1],
          },
        ],
      ]);

      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        null,
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      expect(cache.size).toBe(0);
    });

    it.todo("should deduplicate oracle pubkeys across reserves", async () => {
      const mint1 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const mint2 = "So11111111111111111111111111111111111111112";
      const sharedOracle = new PublicKey(
        "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"
      );

      // Both reserves use the same oracle
      const reserveCache: ReserveCache = new Map([
        [
          mint1,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            scopePriceChain: null,
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [sharedOracle],
          },
        ],
        [
          mint2,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 10000000n,
            cumulativeBorrowRate: 0n,
            scopePriceChain: null,
            loanToValue: 70,
            liquidationThreshold: 75,
            liquidationBonus: 450,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [sharedOracle],
          },
        ],
      ]);

      // Mock Pyth data
      const pythData = Buffer.alloc(3500);
      pythData.writeUInt32LE(0xa1b2c3d4, 0);
      pythData.writeUInt32LE(2, 4);
      pythData.writeUInt32LE(3, 8);
      pythData.writeInt32LE(-8, 20);
      pythData.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 104);
      pythData.writeBigInt64LE(100000000n, 208);
      pythData.writeBigUInt64LE(50000n, 216);
      pythData.writeUInt32LE(1, 224);

      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: pythData, owner: new PublicKey("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH") },
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should only fetch once (deduplicated)
      expect(mockConnection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
      const getMultipleCallsMock = mockConnection.getMultipleAccountsInfo as ReturnType<typeof vi.fn>;
      const callArgs = getMultipleCallsMock.mock.calls[0][0];
      expect(callArgs).toHaveLength(1);

      // Both mints should have the same oracle data
      expect(cache.size).toBe(2);
      expect(cache.get(mint1)).toEqual(cache.get(mint2));
    });

    it("should handle multiple oracles per reserve", async () => {
      const mint1 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const oracle1 = new PublicKey(
        "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"
      );
      const oracle2 = new PublicKey(
        "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo"
      );

      // Reserve has multiple oracles
      const reserveCache: ReserveCache = new Map([
        [
          mint1,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            scopePriceChain: null,
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oracle1, oracle2],
          },
        ],
      ]);

      // Mock Pyth data for oracle1
      const pythData = Buffer.alloc(3500);
      pythData.writeUInt32LE(0xa1b2c3d4, 0);
      pythData.writeUInt32LE(2, 4);
      pythData.writeUInt32LE(3, 8);
      pythData.writeInt32LE(-8, 20);
      pythData.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 104);
      pythData.writeBigInt64LE(100000000n, 208);
      pythData.writeBigUInt64LE(50000n, 216);
      pythData.writeUInt32LE(1, 224);

      // Mock Switchboard data for oracle2
      const switchboardData = Buffer.alloc(500);
      switchboardData.writeBigInt64LE(200000000n, 217);
      switchboardData.writeUInt32LE(8, 225);
      switchboardData.writeBigInt64LE(100000n, 249);
      switchboardData.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 129);

      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: pythData, owner: new PublicKey("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH") },
        { data: switchboardData, owner: new PublicKey("SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f") },
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should fetch both oracles
      expect(mockConnection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
      const getMultipleCallsMock = mockConnection.getMultipleAccountsInfo as ReturnType<typeof vi.fn>;
      const callArgs = getMultipleCallsMock.mock.calls[0][0];
      expect(callArgs).toHaveLength(2);

      // Cache should have entry for mint1 (last oracle wins)
      expect(cache.size).toBe(1);
      expect(cache.has(mint1)).toBe(true);
    });

    it("should handle invalid oracle data gracefully", async () => {
      const mint1 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const oracle1 = new PublicKey(
        "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"
      );

      const reserveCache: ReserveCache = new Map([
        [
          mint1,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            scopePriceChain: null,
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oracle1],
          },
        ],
      ]);

      // Return invalid data (too small)
      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: Buffer.alloc(10), owner: new PublicKey("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH") },
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should not crash, just return empty cache
      expect(cache.size).toBe(0);
    });

    it.todo("should batch fetch oracle accounts in chunks", async () => {
      // Create 150 unique oracles to test batching
      const oracles = Array.from({ length: 150 }, () => PublicKey.unique());
      const mints = oracles.map((_, i) => `mint${i}`);

      const reserveCache: ReserveCache = new Map(
        mints.map((mint, i) => [
          mint,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            scopePriceChain: null,
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oracles[i]],
          },
        ])
      );

      // Mock to return Pyth data for all
      mockConnection.getMultipleAccountsInfo = vi
        .fn()
        .mockImplementation(async (pubkeys: PublicKey[]) => {
          return pubkeys.map(() => {
            const pythData = Buffer.alloc(3500);
            pythData.writeUInt32LE(0xa1b2c3d4, 0);
            pythData.writeUInt32LE(2, 4);
            pythData.writeUInt32LE(3, 8);
            pythData.writeInt32LE(-8, 20);
            pythData.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 104);
            pythData.writeBigInt64LE(100000000n, 208);
            pythData.writeBigUInt64LE(50000n, 216);
            pythData.writeUInt32LE(1, 224);
            return { data: pythData, owner: new PublicKey("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH") };
          });
        });

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should be called twice: once for first 100, once for remaining 50
      expect(mockConnection.getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
      expect(cache.size).toBe(150);
    });

    it.todo("should fallback to manual decoder when SDK fails", async () => {
      const mint1 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const oracle1 = new PublicKey(
        "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix"
      );

      const reserveCache: ReserveCache = new Map([
        [
          mint1,
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 5000000n,
            cumulativeBorrowRate: 0n,
            scopePriceChain: null,
            loanToValue: 75,
            liquidationThreshold: 80,
            liquidationBonus: 500,
            borrowFactor: 100,
            liquidityDecimals: 6,
            collateralDecimals: 6,
            oraclePubkeys: [oracle1],
          },
        ],
      ]);

      // Create Pyth data that will work with manual decoder but might fail with SDK
      // This simulates the real-world scenario where SDK has offset issues
      const pythData = Buffer.alloc(3500);
      // Magic: 0xa1b2c3d4 at offset 0
      pythData.writeUInt32LE(0xa1b2c3d4, 0);
      // Version: 2 at offset 4
      pythData.writeUInt32LE(2, 4);
      // Type: 3 (price account) at offset 8
      pythData.writeUInt32LE(3, 8);
      // Exponent: -8 at offset 20
      pythData.writeInt32LE(-8, 20);
      // Timestamp at offset 104 - use current time
      const currentTimestamp = Math.floor(Date.now() / 1000);
      pythData.writeBigInt64LE(BigInt(currentTimestamp), 104);
      // Price: 100000000 (1 USD with -8 exponent) at offset 208
      pythData.writeBigInt64LE(100000000n, 208);
      // Confidence: 50000 at offset 216
      pythData.writeBigUInt64LE(50000n, 216);
      // Status: 1 (trading) at offset 224
      pythData.writeUInt32LE(1, 224);

      mockConnection.getMultipleAccountsInfo = vi.fn().mockResolvedValue([
        { data: pythData, owner: new PublicKey("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH") },
      ]);

      const cache = await loadOracles(mockConnection, reserveCache);

      // Should successfully decode
      expect(mockConnection.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
      expect(cache.size).toBeGreaterThanOrEqual(1);
      
      // Verify that we got a valid price (either pyth or switchboard decoder worked)
      const price1 = cache.get(mint1);
      expect(price1).toBeDefined();
      // Price should be valid
      expect(price1!.price).toBeGreaterThan(0n);
      expect(price1!.confidence).toBeGreaterThanOrEqual(0n);
      // Exponent should be a reasonable value for price scaling
      expect(price1!.exponent).toBeLessThanOrEqual(0);
      expect(price1!.exponent).toBeGreaterThanOrEqual(-18);
    });
  });
});
