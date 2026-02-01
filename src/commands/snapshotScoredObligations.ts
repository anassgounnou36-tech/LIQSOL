#!/usr/bin/env node
import { PublicKey, Connection } from "@solana/web3.js";
import { loadReadonlyEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { loadReserves } from "../cache/reserveCache.js";
import { loadOracles } from "../cache/oracleCache.js";
import { LiveObligationIndexer } from "../engine/liveObligationIndexer.js";

/**
 * CLI tool for scoring obligations from snapshot with health ratios and liquidation eligibility
 * 
 * Usage: npm run snapshot:scored
 * 
 * Requires environment variables:
 *   - KAMINO_MARKET_PUBKEY: The market pubkey to filter obligations
 *   - KAMINO_KLEND_PROGRAM_ID: The Kamino Lending program ID
 *   - RPC_PRIMARY: Solana RPC endpoint URL
 * 
 * Loads reserves and oracles, then computes health scores for obligations from snapshot,
 * and prints top-N riskiest accounts sorted by health ratio.
 */

async function main() {
  logger.info("Starting scored obligations snapshot...");

  // Load environment
  const env = loadReadonlyEnv();

  // Parse config
  let marketPubkey: PublicKey;
  let programId: PublicKey;

  try {
    marketPubkey = new PublicKey(env.KAMINO_MARKET_PUBKEY);
  } catch {
    logger.error({ pubkey: env.KAMINO_MARKET_PUBKEY }, "Invalid KAMINO_MARKET_PUBKEY");
    process.exit(1);
  }

  try {
    programId = new PublicKey(env.KAMINO_KLEND_PROGRAM_ID);
  } catch {
    logger.error({ pubkey: env.KAMINO_KLEND_PROGRAM_ID }, "Invalid KAMINO_KLEND_PROGRAM_ID");
    process.exit(1);
  }

  logger.info(
    { market: marketPubkey.toString(), program: programId.toString() },
    "Configuration loaded"
  );

  try {
    // Initialize RPC connection
    const connection = new Connection(env.RPC_PRIMARY, "confirmed");
    logger.info({ rpcUrl: env.RPC_PRIMARY }, "Connected to Solana RPC");

    // Load reserves
    logger.info("Loading reserves for market...");
    const reserveCache = await loadReserves(connection, marketPubkey);
    logger.info({ reserveCount: reserveCache.size }, "Reserves loaded");

    // Load oracles
    logger.info("Loading oracles...");
    const oracleCache = await loadOracles(connection, reserveCache);
    logger.info({ oracleCount: oracleCache.size }, "Oracles loaded");

    // Create indexer with caches but without Yellowstone (bootstrap only)
    const indexer = new LiveObligationIndexer({
      yellowstoneUrl: env.YELLOWSTONE_GRPC_URL || "",
      yellowstoneToken: env.YELLOWSTONE_X_TOKEN || "",
      programId,
      rpcUrl: env.RPC_PRIMARY,
      reserveCache,
      oracleCache,
      bootstrapBatchSize: 100,
      bootstrapConcurrency: 5, // Higher concurrency for batch scoring
    });

    // Load snapshot and bootstrap (this will populate cache with scored obligations)
    logger.info("Loading obligation snapshot and computing health scores...");
    
    // Use bootstrapOnly() - loads obligations and computes health without streaming
    await indexer.bootstrapOnly();

    // Get stats
    const stats = indexer.getStats();
    const unscoredCount = stats.cacheSize - stats.scoredCount;
    
    logger.info(
      {
        totalObligations: stats.cacheSize,
        scoredObligations: stats.scoredCount,
        unscoredObligations: unscoredCount,
        liquidatableObligations: stats.liquidatableCount,
      },
      "Scoring complete"
    );
    
    if (unscoredCount > 0) {
      logger.warn(
        { 
          unscoredCount, 
          percentage: ((unscoredCount / stats.cacheSize) * 100).toFixed(1) + "%" 
        },
        "Some obligations were not scored (likely due to missing/stale oracle prices or missing reserves). Check debug logs for details."
      );
    }

    // Get top-N riskiest obligations
    const TOP_N = 50;
    const scoredObligations = indexer.getScoredObligations(TOP_N);

    if (scoredObligations.length === 0) {
      logger.warn("No scored obligations found. Ensure reserves and oracles are loaded correctly.");
      return;
    }

    // Print summary
    logger.info(
      { topN: TOP_N, total: scoredObligations.length },
      "Top riskiest obligations (sorted by health ratio, lowest first)"
    );

    // Print table header
    console.log("\n=== TOP RISKY OBLIGATIONS ===\n");
    console.log(
      "Rank | Health Ratio | Liquidatable | Borrow Value | Collateral Value | Deposits | Borrows | Obligation"
    );
    console.log("-".repeat(150));

    // Print each obligation
    scoredObligations.forEach((obligation, index) => {
      const rank = index + 1;
      const healthRatioStr = obligation.healthRatio.toFixed(4).padStart(12);
      const liquidatableStr = (obligation.liquidationEligible ? "YES" : "NO").padEnd(12);
      const borrowValueStr = `$${obligation.borrowValue.toFixed(2)}`.padStart(12);
      const collateralValueStr = `$${obligation.collateralValue.toFixed(2)}`.padStart(16);
      const depositsStr = obligation.depositsCount.toString().padStart(8);
      const borrowsStr = obligation.borrowsCount.toString().padStart(7);
      const obligationStr = obligation.obligationPubkey;

      console.log(
        `${rank.toString().padStart(4)} | ${healthRatioStr} | ${liquidatableStr} | ${borrowValueStr} | ${collateralValueStr} | ${depositsStr} | ${borrowsStr} | ${obligationStr}`
      );
    });

    console.log("\n");

    // Structured log for programmatic consumption
    logger.info(
      {
        summary: {
          totalScored: scoredObligations.length,
          liquidatableCount: scoredObligations.filter(o => o.liquidationEligible).length,
          averageHealthRatio:
            scoredObligations.reduce((sum, o) => sum + o.healthRatio, 0) /
            scoredObligations.length,
          totalBorrowValue: scoredObligations.reduce((sum, o) => sum + o.borrowValue, 0),
          totalCollateralValue: scoredObligations.reduce(
            (sum, o) => sum + o.collateralValue,
            0
          ),
        },
        topRiskiest: scoredObligations.slice(0, 10).map(o => ({
          obligation: o.obligationPubkey,
          owner: o.ownerPubkey,
          healthRatio: o.healthRatio,
          liquidationEligible: o.liquidationEligible,
          borrowValue: o.borrowValue,
          collateralValue: o.collateralValue,
        })),
      },
      "Scored obligations summary"
    );

    logger.info("Snapshot complete");
  } catch (err) {
    logger.fatal({ err }, "Failed to score obligations");
    process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
