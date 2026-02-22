#!/usr/bin/env node
import { PublicKey } from "@solana/web3.js";
import { writeFileSync, mkdirSync, renameSync } from "fs";
import { dirname, join, resolve } from "path";
import { execSync } from "child_process";
import { pathToFileURL } from "url";
import bs58 from "bs58";
import { getConnection } from "../solana/connection.js";
import { loadReadonlyEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { anchorDiscriminator } from "../kamino/decode/discriminator.js";
// Note: decodeObligation not needed - we only fetch pubkeys via dataSlice
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

export async function snapshotObligationPubkeysToFile(opts: {
  marketPubkey: PublicKey;
  programId: PublicKey;
  outputPath: string;
}): Promise<void> {
  const { marketPubkey, programId, outputPath } = opts;
  logger.info(
    { market: marketPubkey.toString(), program: programId.toString(), outputPath },
    "Starting obligation snapshot via Solana RPC..."
  );

  // Calculate discriminator for Obligation account
  const obligationDiscriminator = anchorDiscriminator("Obligation");
  
  logger.info(
    { discriminator: obligationDiscriminator.toString("hex") },
    "Using Obligation discriminator"
  );

  // Initialize Solana RPC connection
  // Note: Previously used 'finalized' commitment. Now using centralized connection
  // which uses 'confirmed' for consistency. This provides good balance between
  // speed and reliability across all commands.
  const connection = getConnection();
  
  const env = loadReadonlyEnv();
  logger.info({ rpcUrl: env.RPC_PRIMARY }, "Connected to Solana RPC");

  // Define filters for getProgramAccounts
  // Filter: Match Obligation discriminator at offset 0
  // Note: Use base58 encoding for memcmp filter (base64 fails for RPC)
  // Note: No dataSize filter - Kamino V2 obligations are ~1300+ bytes (not 410)
  // Use discriminator + market filters for precise market-specific snapshots
  const filters = [
    {
      memcmp: {
        offset: 0,
        bytes: bs58.encode(obligationDiscriminator),
      },
    },
    {
      memcmp: {
        offset: 32, // 8(discriminator) + 8(tag) + 16(lastUpdate)
        bytes: marketPubkey.toBase58(),
      },
    },
  ];

  // Fetch all matching accounts via RPC
  // Use dataSlice to prevent massive response (only get pubkeys, not account data)
  // Note: length: 1 (not 0) for compatibility with all RPC nodes
  logger.info("Fetching obligation pubkeys via getProgramAccounts...");
  
  const rawAccounts = await connection.getProgramAccounts(programId, {
    filters,
    encoding: "base64",
    dataSlice: { offset: 0, length: 1 }, // Only return pubkeys + metadata, not account data
  });

  logger.info({ total: rawAccounts.length }, "Fetched obligation pubkeys");

  // Collect pubkeys (discriminator + market filters already applied)
  const obligationPubkeys: string[] = rawAccounts.map(ra => ra.pubkey.toString());

  logger.info({ count: obligationPubkeys.length }, "Collected obligation pubkeys");

  // Validate minimum expected obligations (fail fast on configuration errors)
  const MIN_EXPECTED_OBLIGATIONS = 50;
  if (obligationPubkeys.length < MIN_EXPECTED_OBLIGATIONS) {
    throw new Error(
      `Snapshot returned only ${obligationPubkeys.length} obligations (expected at least ${MIN_EXPECTED_OBLIGATIONS}). ` +
      `Likely bad filters or incorrect program ID. Check RPC endpoint, discriminator, and program ID.`
    );
  }

  // Ensure output directory exists
  const resolvedOutputPath = resolve(outputPath);
  mkdirSync(dirname(resolvedOutputPath), { recursive: true });
  const tempPath = `${resolvedOutputPath}.tmp.${Date.now()}`;

  // Write one pubkey per line
  const content = obligationPubkeys.join("\n") + "\n";
  writeFileSync(tempPath, content, "utf-8");

  // Atomic rename
  renameSync(tempPath, resolvedOutputPath);

  logger.info(
    { outputPath: resolvedOutputPath, count: obligationPubkeys.length },
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
    throw new Error("Output contains invalid pubkeys");
  }

  logger.info("All pubkeys validated as valid base58");
}

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

  try {
    await snapshotObligationPubkeysToFile({
      marketPubkey,
      programId,
      outputPath: join("data", "obligations.jsonl"),
    });
  } catch (err) {
    logger.fatal({ err }, "Failed to snapshot obligations");
    process.exit(1);
  }
}

const isDirectRun =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  main().catch((err) => {
    console.error('[Live] FATAL ERROR:', err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error('[Live] Stack:', err.stack);
    process.exit(1);
  });
}
