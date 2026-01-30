#!/usr/bin/env tsx
/**
 * Command to run the live obligation indexer
 * 
 * This demonstrates production usage of the LiveObligationIndexer:
 * - Bootstraps cache from RPC on startup
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
  // Windows platform guard: Yellowstone gRPC native bindings not available on Windows
  if (process.platform === "win32") {
    console.error("");
    console.error("ERROR: Yellowstone gRPC native bindings are not supported on Windows.");
    console.error("");
    console.error("To run the live indexer on Windows, please use WSL2:");
    console.error("  npm run live:indexer:wsl");
    console.error("");
    console.error("For more information about WSL installation:");
    console.error("  https://docs.microsoft.com/en-us/windows/wsl/install");
    console.error("");
    process.exit(1);
  }

  const env = loadReadonlyEnv();

  logger.info(
    { 
      programId: env.KAMINO_KLEND_PROGRAM_ID,
      yellowstoneUrl: env.YELLOWSTONE_GRPC_URL,
      rpcUrl: env.RPC_PRIMARY,
    },
    "Starting live obligation indexer"
  );

  // Create the live indexer
  const indexer = new LiveObligationIndexer({
    yellowstoneUrl: env.YELLOWSTONE_GRPC_URL,
    yellowstoneToken: env.YELLOWSTONE_X_TOKEN,
    programId: new PublicKey(env.KAMINO_KLEND_PROGRAM_ID),
    rpcUrl: env.RPC_PRIMARY,
    commitment: CommitmentLevel.CONFIRMED,
    // Optional: Add filters if you want to filter by market
    filters: [],
    // Reconnection settings
    maxReconnectAttempts: 10,
    reconnectDelayMs: 1000,
    reconnectBackoffFactor: 2,
    // Bootstrap settings
    bootstrapBatchSize: 100,
    bootstrapConcurrency: 1,
    // Inactivity watchdog
    inactivityTimeoutSeconds: 15,
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
        reconnectCount: stats.reconnectCount,
        lastUpdate: stats.lastUpdate ? new Date(stats.lastUpdate).toISOString() : null,
        newestSlot: stats.newestSlot,
      },
      "Indexer stats"
    );
  }, 10000); // Log every 10 seconds

  // Handle shutdown signals
  const shutdownHandler = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");
    clearInterval(statsInterval);
    await indexer.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdownHandler("SIGINT"));
  process.on("SIGTERM", () => shutdownHandler("SIGTERM"));

  // Keep the process alive
  logger.info("Live indexer running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start live indexer");
  process.exit(1);
});
