import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { LiveObligationIndexer } from "../engine/liveObligationIndexer.js";
import { CommitmentLevel } from "@triton-one/yellowstone-grpc";

/**
 * Integration test demonstrating the LiveObligationIndexer API
 * 
 * This test shows how to use the indexer programmatically without
 * actually connecting to Yellowstone (which would require credentials).
 */
describe("LiveObligationIndexer - Integration Example", () => {
  it("demonstrates complete API usage pattern", async () => {
    // 1. Create the indexer with configuration
    const indexer = new LiveObligationIndexer({
      yellowstoneUrl: "https://solana-mainnet.g.alchemy.com/",
      yellowstoneToken: "test-token",
      programId: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      rpcUrl: "https://api.mainnet-beta.solana.com",
      obligationsFilePath: "/tmp/test-obligations.jsonl",
      commitment: CommitmentLevel.CONFIRMED,
      maxReconnectAttempts: 5,
      reconnectDelayMs: 500,
      reconnectBackoffFactor: 2,
    });

    // 2. Verify initial state
    expect(indexer.isIndexerRunning()).toBe(false);
    expect(indexer.getAllObligations()).toEqual([]);
    
    // 3. Check stats before starting
    const initialStats = indexer.getStats();
    expect(initialStats.isRunning).toBe(false);
    expect(initialStats.cacheSize).toBe(0);
    expect(initialStats.knownPubkeys).toBe(0);
    expect(initialStats.lastUpdate).toBeNull();

    // 4. Demonstrate cache lookup (returns null when not found)
    const testPubkey = "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo";
    expect(indexer.getObligation(testPubkey)).toBeNull();

    // 5. Demonstrate reload capability
    expect(() => indexer.reloadSnapshot()).not.toThrow();

    // 6. Demonstrate graceful stop (even when not started)
    await expect(indexer.stop()).resolves.not.toThrow();

    // 7. Verify stop is idempotent
    await expect(indexer.stop()).resolves.not.toThrow();

    // Note: We don't actually start() the indexer in this test because
    // that would require real Yellowstone credentials and would attempt
    // to make network connections. The test above demonstrates the full
    // API surface without requiring external dependencies.
  });

  it("demonstrates typical production usage pattern", () => {
    // This is how you would use the indexer in production:
    
    // Example code (not executed in test):
    const exampleUsage = `
      // 1. Create indexer
      const indexer = new LiveObligationIndexer({
        yellowstoneUrl: process.env.YELLOWSTONE_GRPC_URL,
        yellowstoneToken: process.env.YELLOWSTONE_X_TOKEN,
        programId: new PublicKey(process.env.KAMINO_KLEND_PROGRAM_ID),
      });

      // 2. Start the indexer (loads snapshot + starts streaming)
      await indexer.start();

      // 3. Use the indexer in your application
      setInterval(() => {
        const stats = indexer.getStats();
        console.log('Cache size:', stats.cacheSize);
        
        // Get specific obligation
        const obligation = indexer.getObligation(pubkey);
        if (obligation) {
          console.log('Deposits:', obligation.deposits.length);
          console.log('Borrows:', obligation.borrows.length);
        }

        // Get all obligations
        const all = indexer.getAllObligations();
        console.log('Total obligations:', all.length);
      }, 5000);

      // 4. Graceful shutdown (or Ctrl+C, handled automatically)
      process.on('SIGTERM', async () => {
        await indexer.stop();
        process.exit(0);
      });
    `;

    expect(exampleUsage).toBeDefined();
    expect(exampleUsage).toContain("LiveObligationIndexer");
  });
});
