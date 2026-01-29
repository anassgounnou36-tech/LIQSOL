#!/usr/bin/env tsx
/**
 * Command to run the live obligation indexer
 * 
 * This demonstrates production usage of the LiveObligationIndexer:
 * - Loads obligations from snapshot file (data/obligations.jsonl)
 * - Streams real-time updates via Yellowstone gRPC
 * - Maintains in-memory cache of decoded obligations
 * - Handles reconnection and clean shutdown
 * 
 * Usage:
 *   npm run live:indexer
 *   or
 *   tsx src/commands/liveIndexer.ts
 */

import { PublicKey } from "@solana/web3.js";
import { loadReadonlyEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { LiveObligationIndexer } from "../engine/liveObligationIndexer.js";
import { CommitmentLevel } from "@triton-one/yellowstone-grpc";

async function main() {
  const env = loadReadonlyEnv();

  logger.info(
    { 
      programId: env.KAMINO_KLEND_PROGRAM_ID,
      yellowstoneUrl: env.YELLOWSTONE_GRPC_URL,
    },
    "Starting live obligation indexer"
  );

  // Create the live indexer
  const indexer = new LiveObligationIndexer({
    yellowstoneUrl: env.YELLOWSTONE_GRPC_URL,
    yellowstoneToken: env.YELLOWSTONE_X_TOKEN,
    programId: new PublicKey(env.KAMINO_KLEND_PROGRAM_ID),
    commitment: CommitmentLevel.CONFIRMED,
    // Optional: Add filters if you want to filter by market
    filters: [],
    // Reconnection settings
    maxReconnectAttempts: 10,
    reconnectDelayMs: 1000,
    reconnectBackoffFactor: 2,
  });

  // Start the indexer
  await indexer.start();

  // Log stats periodically
  const statsInterval = setInterval(() => {
    const stats = indexer.getStats();
    logger.info(
      {
        isRunning: stats.isRunning,
        cacheSize: stats.cacheSize,
        knownPubkeys: stats.knownPubkeys,
        lastUpdate: stats.lastUpdate ? new Date(stats.lastUpdate).toISOString() : null,
        newestSlot: stats.newestSlot,
      },
      "Indexer stats"
    );
  }, 30000); // Log every 30 seconds

  // Keep the process alive
  // The indexer will handle SIGINT and SIGTERM for clean shutdown
  logger.info("Live indexer running. Press Ctrl+C to stop.");

  // Cleanup on exit
  process.on("exit", () => {
    clearInterval(statsInterval);
  });
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start live indexer");
  process.exit(1);
});
