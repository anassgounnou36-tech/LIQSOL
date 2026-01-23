import { describe, it, expect, vi } from "vitest";
import { Connection } from "@solana/web3.js";
import { BlockhashManager } from "../infra/blockhashManager.js";

describe("BlockhashManager", () => {
  describe("getFresh", () => {
    it("should use getBlockHeight for cache validation", async () => {
      // Create a mock connection
      const mockConnection = {
        getBlockHeight: vi.fn().mockResolvedValue(100),
        getLatestBlockhash: vi.fn().mockResolvedValue({
          blockhash: "test-blockhash",
          lastValidBlockHeight: 200,
        }),
      } as unknown as Connection;

      const manager = new BlockhashManager(mockConnection, 30);

      // First call should fetch fresh
      await manager.getFresh();

      // Verify getBlockHeight was called (not getSlot)
      expect(mockConnection.getBlockHeight).toHaveBeenCalledWith("processed");
      expect(mockConnection.getLatestBlockhash).toHaveBeenCalledWith(
        "processed"
      );
    });

    it("should return cached blockhash when within safety margin", async () => {
      const mockConnection = {
        getBlockHeight: vi
          .fn()
          .mockResolvedValueOnce(100) // First call
          .mockResolvedValueOnce(120), // Second call (still within safety margin)
        getLatestBlockhash: vi.fn().mockResolvedValue({
          blockhash: "test-blockhash",
          lastValidBlockHeight: 200,
        }),
      } as unknown as Connection;

      const manager = new BlockhashManager(mockConnection, 30);

      // First call
      const first = await manager.getFresh();
      expect(first.blockhash).toBe("test-blockhash");
      expect(first.lastValidBlockHeight).toBe(200);

      // Second call - should use cache since 120 < (200 - 30)
      const second = await manager.getFresh();
      expect(second.blockhash).toBe("test-blockhash");
      expect(second.lastValidBlockHeight).toBe(200);

      // getLatestBlockhash should only be called once
      expect(mockConnection.getLatestBlockhash).toHaveBeenCalledTimes(1);
    });

    it("should refresh blockhash when outside safety margin", async () => {
      const mockConnection = {
        getBlockHeight: vi
          .fn()
          .mockResolvedValueOnce(100) // First call
          .mockResolvedValueOnce(180), // Second call (outside safety margin)
        getLatestBlockhash: vi
          .fn()
          .mockResolvedValueOnce({
            blockhash: "test-blockhash-1",
            lastValidBlockHeight: 200,
          })
          .mockResolvedValueOnce({
            blockhash: "test-blockhash-2",
            lastValidBlockHeight: 250,
          }),
      } as unknown as Connection;

      const manager = new BlockhashManager(mockConnection, 30);

      // First call
      const first = await manager.getFresh();
      expect(first.blockhash).toBe("test-blockhash-1");

      // Second call - should refresh since 180 >= (200 - 30)
      const second = await manager.getFresh();
      expect(second.blockhash).toBe("test-blockhash-2");
      expect(second.lastValidBlockHeight).toBe(250);

      // getLatestBlockhash should be called twice
      expect(mockConnection.getLatestBlockhash).toHaveBeenCalledTimes(2);
    });

    it("should correctly compare block heights (not slots)", async () => {
      // This test verifies the fix: we're comparing block heights to block heights,
      // not slots to block heights (which would be comparing different metrics)

      const mockConnection = {
        getBlockHeight: vi.fn().mockResolvedValue(150),
        getLatestBlockhash: vi.fn().mockResolvedValue({
          blockhash: "test-blockhash",
          lastValidBlockHeight: 200,
        }),
      } as unknown as Connection;

      const manager = new BlockhashManager(mockConnection, 30);

      await manager.getFresh();

      // Verify we're using getBlockHeight (which returns block height)
      // to compare with lastValidBlockHeight (also a block height)
      expect(mockConnection.getBlockHeight).toHaveBeenCalledWith("processed");

      // The old implementation incorrectly used getSlot, which would have been
      // a different property on the connection object
    });
  });
});
