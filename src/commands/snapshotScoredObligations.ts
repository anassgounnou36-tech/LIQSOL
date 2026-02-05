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
 *   - ALLOWLIST_MINTS (optional): Comma-separated list of mint addresses to filter obligations
 *     Example: ALLOWLIST_MINTS="So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
 *     This enables allowlist mode - only obligations touching these mints will be scored.
 * 
 * Loads reserves and oracles, then computes health scores for obligations from snapshot,
 * and prints top-N riskiest accounts sorted by health ratio.
 */

// Well-known mint addresses for convenience
const SOL_MINT = "So11111111111111111111111111111111111111112"; // Native SOL (wrapped SOL)
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC

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

    // Parse allowlist mints from environment if configured
    let allowlistMints: string[] | undefined;
    if (env.ALLOWLIST_MINTS) {
      allowlistMints = env.ALLOWLIST_MINTS.split(",").map(m => m.trim()).filter(m => m.length > 0);
      logger.info(
        { allowlistMints },
        "Allowlist mode enabled - only scoring obligations touching these mints"
      );
    }

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
      marketPubkey, // Filter by configured market
      rpcUrl: env.RPC_PRIMARY,
      reserveCache,
      oracleCache,
      allowlistMints, // Pass allowlist mints for filtering
      bootstrapBatchSize: 100,
      bootstrapConcurrency: 5, // Higher concurrency for batch scoring
    });

    // Load snapshot and bootstrap (this will populate cache with scored obligations)
    logger.info("Loading obligation snapshot and computing health scores...");
    
    // Use bootstrapOnly() - loads obligations and computes health without streaming
    await indexer.bootstrapOnly();

    // Get stats
    const stats = indexer.getStats();
    // Use the indexer's actual unscoredCount which tracks only true scoring failures
    // (excludes empty obligations and other-market obligations which are filtered earlier)
    const unscoredCount = stats.unscoredCount;
    
    logger.info(
      {
        totalObligations: stats.cacheSize,
        scoredObligations: stats.scoredCount,
        unscoredObligations: unscoredCount,
        liquidatableObligations: stats.liquidatableCount,
        emptyObligations: stats.emptyObligations,
        skippedOtherMarkets: stats.skippedOtherMarketsCount,
        skippedAllowlist: stats.skippedAllowlistCount,
        unscoredReasons: stats.unscoredReasons,
      },
      "Scoring complete"
    );
    
    // Print unscored summary to console for visibility
    if (unscoredCount > 0 || stats.skippedAllowlistCount > 0) {
      console.log("\n=== SCORING SUMMARY ===\n");
      
      if (stats.skippedAllowlistCount > 0) {
        console.log(`Allowlist filtering enabled: ${stats.skippedAllowlistCount} obligations skipped (not touching allowlisted mints)`);
      }
      
      if (unscoredCount > 0) {
        console.log(`Total unscored: ${unscoredCount} (${((unscoredCount / stats.cacheSize) * 100).toFixed(1)}%)`);
        console.log("\nBreakdown by reason:");
        
        for (const [reason, count] of Object.entries(stats.unscoredReasons)) {
          const percentage = ((count / unscoredCount) * 100).toFixed(1);
          console.log(`  ${reason.padEnd(25)} : ${count.toString().padStart(5)} (${percentage}%)`);
        }
        
        console.log("\nNote: Unscored obligations are excluded from the Top Risky list below.");
        console.log("Values would show as N/A if they were included.");
      }
      
      console.log("");
      
      if (unscoredCount > 0) {
        logger.warn(
          { 
            unscoredCount, 
            percentage: ((unscoredCount / stats.cacheSize) * 100).toFixed(1) + "%",
            reasons: stats.unscoredReasons,
          },
          "Some obligations were not scored. See unscoredReasons for details."
        );
      }
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
      
      // Display N/A for zero values which indicate missing data
      const borrowValueStr = obligation.borrowValue > 0 
        ? `$${obligation.borrowValue.toFixed(2)}`.padStart(12)
        : "N/A".padStart(12);
      const collateralValueStr = obligation.collateralValue > 0
        ? `$${obligation.collateralValue.toFixed(2)}`.padStart(16)
        : "N/A".padStart(16);
        
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
