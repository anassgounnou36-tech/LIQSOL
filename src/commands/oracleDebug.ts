#!/usr/bin/env node
import { PublicKey, Connection } from "@solana/web3.js";
import { loadReadonlyEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { loadReserves, scopeMintChainMap } from "../cache/reserveCache.js";
import { loadOracles } from "../cache/oracleCache.js";
import { SOL_MINT, USDC_MINT, USDT_MINT } from "../constants/mints.js";
import { uiPriceFromMantissa } from "../utils/priceConversion.js";

/**
 * CLI tool for debugging oracle configuration and chain selection
 * 
 * Usage: npm run oracle:debug
 * 
 * Requires environment variables:
 *   - KAMINO_MARKET_PUBKEY: The market pubkey to filter obligations
 *   - KAMINO_KLEND_PROGRAM_ID: The Kamino Lending program ID
 *   - RPC_PRIMARY: Solana RPC endpoint URL
 *   - LIQSOL_LIQ_MINT_ALLOWLIST (optional): Comma-separated list of liquidity mint addresses to filter
 *     Example: LIQSOL_LIQ_MINT_ALLOWLIST="So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
 *     Default: SOL + USDC
 * 
 * Loads reserves and oracles in allowlist mode, then prints detailed mapping info:
 * - Mint pubkey
 * - Scope oracle pubkey (if Scope)
 * - Configured chains from reserve cache
 * - Raw value + exponent
 * - Computed UI price
 */

async function main() {
  logger.info("Starting oracle debug inspection...");

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
    // Default to SOL+USDC for debugging
    let allowlistMints: string[] = [SOL_MINT, USDC_MINT];

    if (env.LIQSOL_LIQ_MINT_ALLOWLIST !== undefined) {
      if (env.LIQSOL_LIQ_MINT_ALLOWLIST.length > 0) {
        allowlistMints = env.LIQSOL_LIQ_MINT_ALLOWLIST
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
      } else {
        // Empty string disables allowlist
        allowlistMints = [];
      }
    }

    if (allowlistMints.length > 0) {
      logger.info(
        { allowlistMints },
        "Allowlist mode enabled - filtering by liquidity mints"
      );
    } else {
      logger.info("Allowlist mode disabled - inspecting all reserves");
    }

    const allowedLiquidityMints = allowlistMints.length > 0 ? new Set(allowlistMints) : undefined;

    // Load reserves with allowlist filtering
    logger.info("Loading reserves for market...");
    const reserveCache = await loadReserves(connection, marketPubkey, allowedLiquidityMints);
    logger.info({ reserveCount: reserveCache.byReserve.size }, "Reserves loaded");

    // Load oracles
    logger.info("Loading oracles...");
    const oracleCache = await loadOracles(connection, reserveCache, allowedLiquidityMints);
    logger.info({ oracleCount: oracleCache.size }, "Oracles loaded");

    // Print oracle debug info
    logger.info("\n========== ORACLE DEBUG REPORT ==========\n");

    const mintsToInspect = allowedLiquidityMints 
      ? Array.from(allowedLiquidityMints)
      : Array.from(reserveCache.byMint.keys()).slice(0, 10); // Limit to 10 if no allowlist

    for (const mint of mintsToInspect) {
      const reserve = reserveCache.byMint.get(mint);
      const priceData = oracleCache.get(mint);

      console.log(`\n--- Mint: ${mint} ---`);

      if (!reserve) {
        console.log("  Reserve: NOT FOUND in cache");
        continue;
      }

      console.log(`  Liquidity Mint: ${reserve.liquidityMint}`);
      console.log(`  Collateral Mint: ${reserve.collateralMint}`);
      console.log(`  Oracle Pubkeys (${reserve.oraclePubkeys.length}):`);
      
      for (const oraclePubkey of reserve.oraclePubkeys) {
        console.log(`    - ${oraclePubkey.toString()}`);
      }

      // Check if this mint has Scope chain configuration
      const scopeChains = scopeMintChainMap.get(mint);
      if (scopeChains && scopeChains.length > 0) {
        console.log(`  Scope Configured Chains: [${scopeChains.join(", ")}]`);
      } else {
        console.log(`  Scope Configured Chains: None (default to chain 0)`);
      }

      if (!priceData) {
        console.log("  ❌ Price: NOT FOUND in oracle cache");
        console.log("  ⚠️  WARNING: This mint has no price data! Scoring will fail.");
        continue;
      }

      const uiPrice = uiPriceFromMantissa(priceData.price, priceData.exponent);

      console.log(`  Oracle Type: ${priceData.oracleType}`);
      console.log(`  Raw Price (mantissa): ${priceData.price.toString()}`);
      console.log(`  Exponent: ${priceData.exponent}`);
      console.log(`  UI Price: ${uiPrice !== null ? `$${uiPrice.toFixed(6)}` : "INVALID"}`);
      console.log(`  Confidence: ${priceData.confidence.toString()}`);
      console.log(`  Last Update Slot/Timestamp: ${priceData.slot.toString()}`);

      // Sanity check warnings
      if (uiPrice !== null) {
        if (mint === SOL_MINT && (uiPrice < 5 || uiPrice > 2000)) {
          console.log(`  ⚠️  WARNING: SOL price outside expected range [5, 2000] USD`);
        }

        const isStablecoin = mint === USDC_MINT || mint === USDT_MINT;

        if (isStablecoin && (uiPrice < 0.95 || uiPrice > 1.05)) {
          console.log(`  ⚠️  WARNING: Stablecoin price outside expected range [0.95, 1.05] USD`);
        }
      }
    }

    console.log("\n========================================\n");

    logger.info("Oracle debug inspection complete");
    process.exit(0);
  } catch (error) {
    logger.error({ error }, "Fatal error during oracle debug");
    process.exit(1);
  }
}

// Execute
main();
