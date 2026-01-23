#!/usr/bin/env node
import { Connection, PublicKey } from "@solana/web3.js";
import { writeFileSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { loadEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { anchorDiscriminator } from "../kamino/decode/discriminator.js";
import { decodeObligation } from "../kamino/decoder.js";

/**
 * CLI tool for snapshotting obligations from a Kamino Lending market
 * Usage: npm run snapshot:obligations
 * 
 * Requires environment variables:
 *   - KAMINO_MARKET_PUBKEY: The market pubkey to filter obligations
 *   - KAMINO_KLEND_PROGRAM_ID: The Kamino Lending program ID
 * 
 * Outputs obligation pubkeys (one per line) to data/obligations.jsonl
 */

async function main() {
  // Load environment
  const env = loadEnv();
  
  // Get market and program from env
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
    "Starting obligation snapshot..."
  );

  // Setup connection
  const connection = new Connection(env.RPC_PRIMARY, "confirmed");

  // Calculate discriminator for Obligation account
  const obligationDiscriminator = anchorDiscriminator("Obligation");
  
  logger.info(
    { discriminator: obligationDiscriminator.toString("hex") },
    "Using Obligation discriminator"
  );

  try {
    // Fetch all program accounts with Obligation discriminator
    logger.info("Fetching obligation accounts...");
    
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: obligationDiscriminator.toString("base64"),
          },
        },
      ],
    });

    logger.info({ total: accounts.length }, "Fetched obligation accounts");

    // Decode using IDL and filter by market
    const obligationPubkeys: string[] = [];
    
    for (const { pubkey, account } of accounts) {
      try {
        // Decode obligation using IDL-based decoder
        const decoded = decodeObligation(account.data, pubkey);
        
        // Filter by market pubkey
        if (decoded.marketPubkey === marketPubkey.toString()) {
          obligationPubkeys.push(pubkey.toString());
        }
      } catch (error) {
        logger.warn(
          { pubkey: pubkey.toString(), error },
          "Failed to decode obligation"
        );
      }
    }

    logger.info({ count: obligationPubkeys.length }, "Filtered obligations by market");

    if (obligationPubkeys.length === 0) {
      logger.warn("No obligations found for the specified market");
      process.exit(0);
    }

    // Ensure data directory exists
    const dataDir = join(process.cwd(), "data");
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch {
      // Directory might already exist, that's fine
    }

    // Write to temp file then rename for atomicity
    const outputPath = join(dataDir, "obligations.jsonl");
    const tempPath = join(dataDir, `.obligations.jsonl.tmp.${Date.now()}`);

    // Write one pubkey per line
    const content = obligationPubkeys.join("\n") + "\n";
    writeFileSync(tempPath, content, "utf-8");

    // Atomic rename
    renameSync(tempPath, outputPath);

    logger.info(
      { outputPath, count: obligationPubkeys.length },
      "Snapshot complete"
    );

    // Validate output
    const isValid = obligationPubkeys.every(pubkey => {
      try {
        new PublicKey(pubkey);
        return true;
      } catch {
        return false;
      }
    });

    if (!isValid) {
      logger.error("Output contains invalid pubkeys");
      process.exit(1);
    }

    logger.info("All pubkeys validated as valid base58");
  } catch (error) {
    logger.error({ error }, "Failed to snapshot obligations");
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error({ error }, "Fatal error");
  process.exit(1);
});
