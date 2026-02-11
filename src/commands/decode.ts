#!/usr/bin/env node
/**
 * @deprecated This unified decode command is deprecated.
 * Use separate commands instead:
 *   - npm run decode:reserve <reserve_pubkey>
 *   - npm run decode:obligation <obligation_pubkey>
 */
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../solana/connection.js";
import { loadEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { decodeReserve, decodeObligation } from "../kamino/decoder.js";

/**
 * CLI tool for decoding Kamino Lending accounts
 * Usage:
 *   npm run decode:reserve <reserve_pubkey>
 *   npm run decode:obligation <obligation_pubkey>
 */

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage:");
    console.error("  npm run decode:reserve <reserve_pubkey>");
    console.error("  npm run decode:obligation <obligation_pubkey>");
    process.exit(1);
  }

  const [accountType, pubkeyStr] = args;

  // Validate account type
  if (accountType !== "reserve" && accountType !== "obligation") {
    console.error(
      "Invalid account type. Must be 'reserve' or 'obligation'."
    );
    process.exit(1);
  }

  // Validate pubkey
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(pubkeyStr);
  } catch {
    console.error("Invalid public key:", pubkeyStr);
    process.exit(1);
  }

  // Load environment and setup connection
  const env = loadEnv();
  const connection = getConnection();

  logger.info(
    { accountType, pubkey: pubkey.toString() },
    "Fetching account data..."
  );

  try {
    // Fetch account data
    const accountInfo = await connection.getAccountInfo(pubkey);

    if (!accountInfo) {
      logger.error({ pubkey: pubkey.toString() }, "Account not found");
      process.exit(1);
    }

    if (!accountInfo.data) {
      logger.error({ pubkey: pubkey.toString() }, "Account has no data");
      process.exit(1);
    }

    logger.info(
      { dataLength: accountInfo.data.length },
      "Account data fetched successfully"
    );

    // Decode based on account type
    if (accountType === "reserve") {
      const decoded = decodeReserve(accountInfo.data, pubkey);
      console.log("\n=== Decoded Reserve ===");
      console.log(JSON.stringify(decoded, null, 2));
    } else if (accountType === "obligation") {
      const decoded = decodeObligation(accountInfo.data, pubkey);
      console.log("\n=== Decoded Obligation ===");
      console.log(JSON.stringify(decoded, null, 2));
    }

    logger.info("Decode successful");
  } catch (error) {
    logger.error({ error, pubkey: pubkey.toString() }, "Failed to decode account");
    console.error("\nError:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
