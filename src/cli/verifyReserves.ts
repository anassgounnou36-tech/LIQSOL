#!/usr/bin/env node
import { Connection, PublicKey } from "@solana/web3.js";
import { loadReadonlyEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { loadReserves } from "../cache/reserveCache.js";

/**
 * CLI tool for verifying decoded reserves from a Kamino Lending market
 * Usage: npm run verify:reserves
 *
 * Requires environment variables:
 *   - KAMINO_MARKET_PUBKEY: The market pubkey to load reserves from
 *   - RPC_PRIMARY: Solana RPC endpoint URL
 *
 * Outputs reserve details to console with structured logging
 */

async function main() {
  logger.info("Starting reserve verification CLI...");

  // Load environment
  const env = loadReadonlyEnv();

  // Get market from env
  let marketPubkey: PublicKey;

  try {
    marketPubkey = new PublicKey(env.KAMINO_MARKET_PUBKEY);
  } catch {
    logger.error(
      { pubkey: env.KAMINO_MARKET_PUBKEY },
      "Invalid KAMINO_MARKET_PUBKEY"
    );
    process.exit(1);
  }

  logger.info(
    { market: marketPubkey.toString(), rpc: env.RPC_PRIMARY },
    "Connecting to Solana RPC..."
  );

  try {
    // Initialize Solana RPC connection
    const connection = new Connection(env.RPC_PRIMARY, "confirmed");

    // Load reserves
    const reserves = await loadReserves(connection, marketPubkey);

    logger.info({ count: reserves.size }, "Reserves loaded successfully");

    // Display reserve details
    logger.info("=".repeat(80));
    logger.info("RESERVE DETAILS");
    logger.info("=".repeat(80));

    for (const [mint, reserve] of reserves.entries()) {
      logger.info("");
      logger.info(`Liquidity Mint: ${mint}`);
      logger.info(`  Reserve Pubkey: ${reserve.reservePubkey.toString()}`);
      logger.info(`  Available Amount: ${reserve.availableAmount.toString()}`);
      if (reserve.cumulativeBorrowRate !== undefined) {
        logger.info(
          `  Cumulative Borrow Rate: ${reserve.cumulativeBorrowRate.toString()}`
        );
      }
      logger.info(`  Loan to Value: ${reserve.loanToValue}%`);
      logger.info(
        `  Liquidation Threshold: ${reserve.liquidationThreshold}%`
      );
      logger.info(
        `  Liquidation Bonus: ${reserve.liquidationBonus} bps`
      );
      logger.info(
        `  Oracles (${reserve.oraclePubkeys.length}):`
      );
      for (const oracle of reserve.oraclePubkeys) {
        logger.info(`    - ${oracle.toString()}`);
      }
    }

    logger.info("");
    logger.info("=".repeat(80));
    logger.info(
      {
        market: marketPubkey.toString(),
        totalReserves: reserves.size,
      },
      "Reserve verification complete"
    );
  } catch (err) {
    logger.fatal({ err }, "Failed to verify reserves");
    process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
