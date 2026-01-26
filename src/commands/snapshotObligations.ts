#!/usr/bin/env node
import { Connection, PublicKey } from "@solana/web3.js";
import { writeFileSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import bs58 from "bs58";
import { loadReadonlyEnv } from "../config/env.js";
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

/**
 * Helper function to chunk an array into smaller batches
 */
function* chunk<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) {
    yield arr.slice(i, i + size);
  }
}

async function main() {
  // Load environment
  const env = loadReadonlyEnv();
  
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
    // Fetch all program accounts with Obligation discriminator (pubkeys only)
    logger.info("Fetching obligation account pubkeys...");
    
    const accounts = await connection.getProgramAccounts(programId, {
      commitment: "confirmed",
      encoding: "base64",
      dataSlice: { offset: 0, length: 0 }, // prevents huge response bodies
      filters: [
        {
          memcmp: {
            offset: 0,
            // Use base58 encoding as required by Solana RPC memcmp filter (not base64)
            bytes: bs58.encode(obligationDiscriminator),
          },
        },
      ],
    });

    logger.info({ total: accounts.length }, "Fetched obligation account pubkeys");

    // Extract pubkeys from the response
    const allPubkeys = accounts.map(({ pubkey }) => pubkey);
    
    // Fetch account data in batches and decode
    const obligationPubkeys: string[] = [];
    const BATCH_SIZE = 100;
    const chunks = Array.from(chunk(allPubkeys, BATCH_SIZE));
    
    logger.info({ totalChunks: chunks.length, batchSize: BATCH_SIZE }, "Starting batched account fetching");
    
    for (let i = 0; i < chunks.length; i++) {
      const pubkeysChunk = chunks[i];
      
      // Log progress every chunk
      logger.info(
        { chunk: i + 1, total: chunks.length, accounts: pubkeysChunk.length },
        "Fetching account data batch"
      );
      
      const infos = await connection.getMultipleAccountsInfo(pubkeysChunk, "confirmed");
      
      for (let j = 0; j < infos.length; j++) {
        const info = infos[j];
        const pubkey = pubkeysChunk[j];
        
        if (info === null) {
          logger.warn({ pubkey: pubkey.toString() }, "Account data is null");
          continue;
        }
        
        try {
          // Verify the obligation discriminator on the data
          if (info.data.length < 8) {
            logger.warn({ pubkey: pubkey.toString() }, "Account data too short");
            continue;
          }
          
          const dataDiscriminator = info.data.slice(0, 8);
          if (!dataDiscriminator.equals(obligationDiscriminator)) {
            logger.warn({ pubkey: pubkey.toString() }, "Discriminator mismatch");
            continue;
          }
          
          // Decode obligation using IDL-based decoder
          const decoded = decodeObligation(info.data, pubkey);
          
          // Filter by market pubkey using PublicKey comparison for safety
          const decodedMarket = new PublicKey(decoded.marketPubkey);
          if (decodedMarket.equals(marketPubkey)) {
            obligationPubkeys.push(pubkey.toString());
          }
        } catch (err) {
          logger.warn(
            { pubkey: pubkey.toString(), err },
            "Failed to decode obligation"
          );
        }
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
  } catch (err) {
    logger.fatal({ err }, "Failed to snapshot obligations");
    process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
