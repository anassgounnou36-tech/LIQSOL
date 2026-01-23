#!/usr/bin/env node
import { Connection, PublicKey } from "@solana/web3.js";
import { loadEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { decodeObligation } from "../kamino/decoder.js";

/**
 * CLI tool for decoding Kamino Lending Obligation accounts
 * Usage: npm run decode:obligation <obligation_pubkey>
 * 
 * Outputs JSON to stdout, logs to stderr
 */

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    logger.error("Usage: npm run decode:obligation <obligation_pubkey>");
    process.exit(1);
  }

  const pubkeyStr = args[0];

  // Validate pubkey
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(pubkeyStr);
  } catch {
    logger.error({ pubkey: pubkeyStr }, "Invalid public key");
    process.exit(1);
  }

  // Load environment and setup connection
  const env = loadEnv();
  const connection = new Connection(env.RPC_PRIMARY, "confirmed");

  logger.info(
    { pubkey: pubkey.toString() },
    "Fetching Obligation account data..."
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

    // Decode
    const decoded = decodeObligation(accountInfo.data, pubkey);
    
    // Output JSON to stdout only
    process.stdout.write(JSON.stringify(decoded, null, 2) + "\n");
    
    logger.info("Decode successful");
  } catch (error) {
    logger.error({ error, pubkey: pubkey.toString() }, "Failed to decode account");
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error({ error }, "Fatal error");
  process.exit(1);
});
