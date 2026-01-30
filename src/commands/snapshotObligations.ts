#!/usr/bin/env node
import { PublicKey, Connection } from "@solana/web3.js";
import { writeFileSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { loadReadonlyEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { anchorDiscriminator } from "../kamino/decode/discriminator.js";
import { decodeObligation } from "../kamino/decoder.js";
import { checkYellowstoneNativeBinding } from "../yellowstone/preflight.js";

/**
 * CLI tool for snapshotting obligations from a Kamino Lending market via Solana RPC
 * Usage: npm run snapshot:obligations
 * 
 * Requires environment variables:
 *   - KAMINO_MARKET_PUBKEY: The market pubkey to filter obligations
 *   - KAMINO_KLEND_PROGRAM_ID: The Kamino Lending program ID
 *   - RPC_PRIMARY: Solana RPC endpoint URL
 * 
 * Outputs obligation pubkeys (one per line) to data/obligations.jsonl
 */

async function main() {
  // Preflight: Check Yellowstone native binding availability for WSL fallback only
  const yf = checkYellowstoneNativeBinding();
  if (!yf.ok) {
    // On Windows, automatically fall back to WSL runner
    if (process.platform === "win32") {
      logger.info("Yellowstone native binding missing on Windows. Running snapshot via WSL...");
      
      try {
        // Execute the PowerShell script and forward stdout/stderr
        const scriptPath = join(process.cwd(), "scripts", "run_snapshot_wsl.ps1");
        execSync(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, {
          stdio: "inherit",
          cwd: process.cwd()
        });
        // If successful, exit with success code
        process.exit(0);
      } catch (err) {
        // execSync throws on non-zero exit code
        // Exit with the same code as the WSL run
        const exitCode = 
          err instanceof Error && 'status' in err && typeof (err as { status?: number }).status === 'number'
            ? (err as { status: number }).status
            : 1;
        process.exit(exitCode);
      }
    }
    
    // Non-Windows: Proceed with RPC snapshot (doesn't need Yellowstone binding)
    logger.info("Yellowstone binding not available, using RPC snapshot");
  }

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
    "Starting obligation snapshot via Solana RPC..."
  );

  // Calculate discriminator for Obligation account
  const obligationDiscriminator = anchorDiscriminator("Obligation");
  
  logger.info(
    { discriminator: obligationDiscriminator.toString("hex") },
    "Using Obligation discriminator"
  );

  try {
    // Initialize Solana RPC connection
    const connection = new Connection(env.RPC_PRIMARY, "finalized");
    
    logger.info({ rpcUrl: env.RPC_PRIMARY }, "Connected to Solana RPC");

    // Define filters for getProgramAccounts
    // Filter: Match Obligation discriminator at offset 0
    // Note: Use base58 encoding for memcmp filter (base64 fails for RPC)
    const filters = [
      {
        memcmp: {
          offset: 0,
          bytes: obligationDiscriminator.toString("base58"),
        },
      },
    ];

    // Fetch all matching accounts via RPC
    logger.info("Fetching obligation accounts via getProgramAccounts...");
    
    const rawAccounts = await connection.getProgramAccounts(programId, {
      filters,
      encoding: "base64", // Required for decoding full obligation layout
    });

    logger.info({ total: rawAccounts.length }, "Fetched obligation accounts");

    // Filter and decode obligations by market
    const obligationPubkeys: string[] = [];
    
    for (const rawAccount of rawAccounts) {
      try {
        const pubkey = rawAccount.pubkey;
        const accountData = Buffer.from(rawAccount.account.data, "base64");
        
        // Verify the obligation discriminator on the data
        if (accountData.length < 8) {
          logger.warn({ pubkey: pubkey.toString() }, "Account data too short");
          continue;
        }
        
        const dataDiscriminator = accountData.slice(0, 8);
        if (!dataDiscriminator.equals(obligationDiscriminator)) {
          logger.warn({ pubkey: pubkey.toString() }, "Discriminator mismatch");
          continue;
        }
        
        // Decode obligation using IDL-based decoder
        const decoded = decodeObligation(accountData, pubkey);
        
        // Filter by market pubkey using PublicKey comparison for safety
        const decodedMarket = new PublicKey(decoded.marketPubkey);
        if (decodedMarket.equals(marketPubkey)) {
          obligationPubkeys.push(pubkey.toString());
        }
      } catch (err) {
        logger.warn(
          { pubkey: rawAccount.pubkey.toString(), err },
          "Failed to decode obligation"
        );
      }
    }

    logger.info({ count: obligationPubkeys.length }, "Filtered obligations by market");

    // Validate minimum expected obligations (fail fast on configuration errors)
    const MIN_EXPECTED_OBLIGATIONS = 50;
    if (obligationPubkeys.length < MIN_EXPECTED_OBLIGATIONS) {
      throw new Error(
        `Snapshot returned only ${obligationPubkeys.length} obligations (expected at least ${MIN_EXPECTED_OBLIGATIONS}). ` +
        `This is likely incomplete. Check RPC endpoint, program ID, and market pubkey.`
      );
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
