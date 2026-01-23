#!/usr/bin/env node
import { Connection, PublicKey } from "@solana/web3.js";
import { writeFileSync } from "fs";
import { join } from "path";
import { loadEnv } from "../src/config/env.js";
import { logger } from "../src/observability/logger.js";

/**
 * Script to fetch account data from Solana and save as base64 fixture
 * Usage: npm run fetch:fixture -- <pubkey> <output_name> [--expected-market <market>] [--expected-mint <mint>]
 * 
 * Example:
 *   npm run fetch:fixture -- EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v reserve_usdc --expected-market 7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF --expected-mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 */

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    logger.error("Usage: npm run fetch:fixture -- <pubkey> <output_name> [--expected-market <market>] [--expected-mint <mint>]");
    process.exit(1);
  }

  const pubkeyStr = args[0];
  const outputName = args[1];
  
  // Parse optional flags
  let expectedMarket: string | undefined;
  let expectedMint: string | undefined;
  
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--expected-market" && i + 1 < args.length) {
      expectedMarket = args[i + 1];
      i++;
    } else if (args[i] === "--expected-mint" && i + 1 < args.length) {
      expectedMint = args[i + 1];
      i++;
    }
  }

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

  logger.info({ pubkey: pubkey.toString() }, "Fetching account data...");

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

    // Convert to base64
    const dataBase64 = Buffer.from(accountInfo.data).toString("base64");

    // Create fixture object
    const fixture: {
      pubkey: string;
      data_base64: string;
      expected?: {
        market?: string;
        liquidityMint?: string;
      };
    } = {
      pubkey: pubkey.toString(),
      data_base64: dataBase64,
    };

    // Add expected fields if provided
    if (expectedMarket || expectedMint) {
      fixture.expected = {};
      if (expectedMarket) fixture.expected.market = expectedMarket;
      if (expectedMint) fixture.expected.liquidityMint = expectedMint;
    }

    // Save to file
    const fixturePath = join(
      process.cwd(),
      "test",
      "fixtures",
      `${outputName}.json`
    );
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));

    logger.info({ fixturePath }, "Fixture saved successfully");
    logger.info({ pubkey: pubkey.toString(), outputName }, "Fixture generation complete");
  } catch (error) {
    logger.error({ error, pubkey: pubkey.toString() }, "Failed to fetch account");
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error({ error }, "Fatal error");
  process.exit(1);
});
