#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../solana/connection.js";
import { loadReadonlyEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { loadReserves } from "../cache/reserveCache.js";
import { loadOracles } from "../cache/oracleCache.js";
import { LiveObligationIndexer } from "../engine/liveObligationIndexer.js";
import { SOL_MINT, USDC_MINT } from "../constants/mints.js";
import { selectCandidates, type ScoredObligation } from "../strategy/candidateSelector.js";
import { explainHealth } from "../math/healthBreakdown.js";

/**
 * CLI tool for selecting and ranking liquidation candidates from scored obligations
 * 
 * Usage: npm run snapshot:candidates -- --top=50 --near=1.02 --validate-samples=5
 * 
 * Requires environment variables:
 *   - KAMINO_MARKET_PUBKEY: The market pubkey to filter obligations
 *   - KAMINO_KLEND_PROGRAM_ID: The Kamino Lending program ID
 *   - RPC_PRIMARY: Solana RPC endpoint URL
 *   - LIQSOL_LIQ_MINT_ALLOWLIST (optional): Comma-separated list of liquidity mint addresses to filter
 * 
 * Loads reserves and oracles, bootstraps scored obligations, selects candidates,
 * and writes machine-readable output to data/candidates.json.
 */

async function main() {
  logger.info("Starting candidate selection from scored obligations...");

  // Load environment first to get defaults
  const env = loadReadonlyEnv();

  // Get defaults from env (already validated by zod schema)
  const envTop = Number(env.CAND_TOP);
  const envNear = Number(env.CAND_NEAR);
  const envValidate = Number(env.CAND_VALIDATE_SAMPLES);

  // Parse command-line arguments (override env if provided)
  const args = process.argv.slice(2);
  const topArgRaw = args.find((a) => a.startsWith("--top="));
  const nearArgRaw = args.find((a) => a.startsWith("--near="));
  const validateArgRaw = args.find((a) => a.startsWith("--validate-samples="));
  
  const topArg = topArgRaw ? Number(topArgRaw.split("=")[1]) : envTop;
  const nearArg = nearArgRaw ? Number(nearArgRaw.split("=")[1]) : envNear;
  const validateArg = validateArgRaw ? Number(validateArgRaw.split("=")[1]) : envValidate;

  logger.info(
    { top: topArg, nearThreshold: nearArg, validateSamples: validateArg },
    "Resolved parameters (env + CLI overrides)"
  );

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
    const connection = getConnection();
    logger.info({ rpcUrl: env.RPC_PRIMARY }, "Connected to Solana RPC");

    // Parse allowlist mints from environment if configured
    // Default to SOL+USDC for PR7 gate behavior
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
      logger.info("Allowlist mode disabled - scoring all obligations");
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

    // Create indexer with caches but without Yellowstone (bootstrap only)
    const indexer = new LiveObligationIndexer({
      yellowstoneUrl: env.YELLOWSTONE_GRPC_URL || "",
      yellowstoneToken: env.YELLOWSTONE_X_TOKEN || "",
      programId,
      marketPubkey, // Filter by configured market
      rpcUrl: env.RPC_PRIMARY,
      reserveCache,
      oracleCache,
      allowedLiquidityMints, // Pass allowlist set for reserve-based filtering
      bootstrapBatchSize: 100,
      bootstrapConcurrency: 5, // Higher concurrency for batch scoring
    });

    // Load snapshot and bootstrap (this will populate cache with scored obligations)
    logger.info("Loading obligation snapshot and computing health scores...");
    
    // Use bootstrapOnly() - loads obligations and computes health without streaming
    await indexer.bootstrapOnly();

    // Get stats
    const stats = indexer.getStats();
    
    logger.info(
      {
        totalObligations: stats.cacheSize,
        scoredObligations: stats.scoredCount,
        unscoredObligations: stats.unscoredCount,
        liquidatableObligations: stats.liquidatableCount,
      },
      "Bootstrap completed"
    );

    // Get all scored obligations
    const scoredObligations = indexer.getScoredObligations();

    if (scoredObligations.length === 0) {
      logger.warn("No scored obligations found. Ensure reserves and oracles are loaded correctly.");
      return;
    }

    // Map to ScoredObligation interface for candidate selector
    // PR: Enrich with reserve pubkeys from obligation borrows/deposits
    const scoredForSelection: ScoredObligation[] = scoredObligations.map((o) => {
      // Get full obligation entry to access borrows and deposits
      const entry = indexer.getObligationEntry(o.obligationPubkey);
      
      // Extract reserve pubkeys - select repay from borrows, collateral from deposits
      let repayReservePubkey: string | undefined;
      let collateralReservePubkey: string | undefined;
      let primaryBorrowMint: string | undefined;
      let primaryCollateralMint: string | undefined;
      
      if (entry && entry.decoded) {
        // Select repay reserve: prefer USDC, otherwise take first borrow
        const borrows = entry.decoded.borrows.filter((b) => b.reserve !== PublicKey.default.toString());
        if (borrows.length > 0) {
          // Try to find USDC borrow first
          const usdcBorrow = borrows.find((b) => {
            const reserve = reserveCache.byMint.get(b.mint);
            return reserve && reserve[0].liquidityMint === USDC_MINT;
          });
          
          const selectedBorrow = usdcBorrow || borrows[0];
          repayReservePubkey = selectedBorrow.reserve;
          primaryBorrowMint = selectedBorrow.mint;
        }
        
        // Select collateral reserve: prefer SOL, otherwise take first deposit
        const deposits = entry.decoded.deposits.filter((d) => d.reserve !== PublicKey.default.toString());
        if (deposits.length > 0) {
          // Try to find SOL deposit first
          const solDeposit = deposits.find((d) => {
            const reserve = reserveCache.byMint.get(d.mint);
            return reserve && reserve[0].liquidityMint === SOL_MINT;
          });
          
          const selectedDeposit = solDeposit || deposits[0];
          collateralReservePubkey = selectedDeposit.reserve;
          primaryCollateralMint = selectedDeposit.mint;
        }
      }
      
      return {
        obligationPubkey: o.obligationPubkey,
        ownerPubkey: o.ownerPubkey,
        healthRatio: o.healthRatio,
        liquidationEligible: o.liquidationEligible,
        borrowValueUsd: o.borrowValue,
        collateralValueUsd: o.collateralValue,
        repayReservePubkey,
        collateralReservePubkey,
        primaryBorrowMint,
        primaryCollateralMint,
      };
    });

    // Select and rank candidates
    logger.info("Selecting and ranking candidates...");
    const candidates = selectCandidates(scoredForSelection, { nearThreshold: nearArg });
    const topN = candidates.slice(0, topArg);

    // Report candidate counts after selection
    const candLiquidatable = candidates.filter(c => c.liquidationEligible).length;
    const candNear = candidates.filter(c => c.predictedLiquidatableSoon).length;

    logger.info(
      { scoredCount: scoredObligations.length, topCount: topN.length },
      "PR8 candidates selected"
    );

    // Print summary
    console.log("\n=== PR8 CANDIDATE SELECTION ===\n");
    console.log(`\nCandidates liquidatable: ${candLiquidatable}`);
    console.log(`Candidates near-threshold (<= ${nearArg}): ${candNear}\n`);
    console.log(
      "Rank | Priority     | Distance | Liquidatable | Near Threshold | Borrow Value | Collateral Value | Health Ratio | Obligation"
    );
    console.log("-".repeat(170));

    topN.forEach((c, index) => {
      const rank = (index + 1).toString().padStart(4);
      const priorityStr = c.priorityScore.toFixed(2).padStart(12);
      const distanceStr = c.distanceToLiquidation.toFixed(4).padStart(8);
      const liquidatableStr = (c.liquidationEligible ? "YES" : "NO").padEnd(12);
      const nearThresholdStr = (c.predictedLiquidatableSoon ? "YES" : "NO").padEnd(14);
      const borrowValueStr = `$${c.borrowValueUsd.toFixed(2)}`.padStart(12);
      const collateralValueStr = `$${c.collateralValueUsd.toFixed(2)}`.padStart(16);
      const healthRatioStr = c.healthRatio.toFixed(4).padStart(12);
      const obligationStr = c.obligationPubkey;

      console.log(
        `${rank} | ${priorityStr} | ${distanceStr} | ${liquidatableStr} | ${nearThresholdStr} | ${borrowValueStr} | ${collateralValueStr} | ${healthRatioStr} | ${obligationStr}`
      );
    });

    console.log("\n");

    // Write machine-readable output
    const outPath = path.join("data", "candidates.json");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ candidates: topN }, null, 2));
    logger.info({ path: outPath }, "Candidate data written to JSON file");

    // Optional: print validation samples
    if (validateArg > 0) {
      console.log(`\n=== VALIDATION SAMPLES (first ${validateArg}) ===\n`);
      
      for (let i = 0; i < Math.min(validateArg, topN.length); i++) {
        const c = topN[i];
        console.log(`\n--- Candidate ${i + 1}: ${c.obligationPubkey} ---`);
        
        // Get the full obligation entry from cache using public accessor
        const entry = indexer.getObligationEntry(c.obligationPubkey);
        
        if (entry) {
          const breakdown = explainHealth(entry.decoded, reserveCache, oracleCache);
          console.log("\nDeposits (Collateral):");
          breakdown.deposits.forEach((d) => {
            console.log(`  Mint: ${d.mint}`);
            if (d.underlyingMint) {
              console.log(`    Underlying Mint: ${d.underlyingMint}`);
            }
            console.log(`    Amount UI: ${d.amountUi.toFixed(6)}`);
            console.log(`    Price USD: $${d.priceUsd.toFixed(6)}`);
            console.log(`    USD Value: $${d.usdValue.toFixed(2)}`);
            console.log(`    Liquidation Threshold: ${((d.threshold || 0) * 100).toFixed(2)}%`);
            console.log(`    Weighted Value: $${(d.weightedValue || 0).toFixed(2)}`);
          });
          
          console.log("\nBorrows:");
          breakdown.borrows.forEach((b) => {
            console.log(`  Mint: ${b.mint}`);
            console.log(`    Amount UI: ${b.amountUi.toFixed(6)}`);
            console.log(`    Price USD: $${b.priceUsd.toFixed(6)}`);
            console.log(`    USD Value: $${b.usdValue.toFixed(2)}`);
            console.log(`    Borrow Factor: ${((b.factor || 1) * 100).toFixed(2)}%`);
            console.log(`    Weighted Value: $${(b.weightedValue || 0).toFixed(2)}`);
          });
          
          console.log("\nTotals:");
          console.log(`  Collateral USD (raw): $${breakdown.totals.collateralUsdRaw.toFixed(2)}`);
          console.log(`  Collateral USD (adjusted): $${breakdown.totals.collateralUsdAdj.toFixed(2)}`);
          console.log(`  Borrow USD (raw): $${breakdown.totals.borrowUsdRaw.toFixed(2)}`);
          console.log(`  Borrow USD (adjusted): $${breakdown.totals.borrowUsdAdj.toFixed(2)}`);
          console.log(`  Health Ratio: ${breakdown.totals.healthRatio.toFixed(4)}`);
          if (breakdown.totals.healthRatioRaw !== undefined) {
            console.log(`  Health Ratio (unclamped): ${breakdown.totals.healthRatioRaw.toFixed(4)}`);
          }
          
          // Compare with candidate table values for consistency check
          console.log("\n  Candidate table values (for comparison):");
          console.log(`    Borrow Value: $${c.borrowValueUsd.toFixed(2)}`);
          console.log(`    Collateral Value: $${c.collateralValueUsd.toFixed(2)}`);
          console.log(`    Health Ratio: ${c.healthRatio.toFixed(4)}`);
          
          if (breakdown.flags.missingLegs > 0 || breakdown.flags.approximations.length > 0) {
            console.log("\nFlags:");
            console.log(`  Missing Legs: ${breakdown.flags.missingLegs}`);
            if (breakdown.flags.approximations.length > 0) {
              console.log(`  Approximations:`);
              breakdown.flags.approximations.forEach((a) => console.log(`    - ${a}`));
            }
          }
        } else {
          console.log("  (Obligation not found in cache)");
        }
      }
      console.log("\n");
    }

    logger.info("Candidate selection complete");
  } catch (err) {
    logger.fatal({ err }, "Failed to select candidates");
    process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error");
  process.exit(1);
});
