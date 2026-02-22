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
import { divBigintToNumber } from "../utils/bn.js";

const ratio = (a?: number, b?: number) =>
  (a && b && b > 0) ? (a / b).toFixed(4) : 'n/a';

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
    const currentSlot = await connection.getSlot('confirmed');
    logger.info({ currentSlot }, "Current slot");

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
        "Execution allowlist enabled (repay/collateral leg selection only)"
      );
    } else {
      logger.info("Execution allowlist disabled - any mint allowed for leg selection");
    }

    const allowedLiquidityMints = allowlistMints.length > 0 ? new Set(allowlistMints) : undefined;

    // Load reserves/oracles over FULL market (no allowlist for scoring)
    logger.info("Loading reserves for market...");
    const reserveCache = await loadReserves(connection, marketPubkey, undefined);
    logger.info({ reserveCount: reserveCache.byReserve.size }, "Reserves loaded");

    // Load oracles
    logger.info("Loading oracles...");
    const oracleCache = await loadOracles(connection, reserveCache, undefined);
    logger.info({ oracleCount: oracleCache.size }, "Oracles loaded");

    // Create indexer WITHOUT allowlist (scoring must see full portfolio)
    const indexer = new LiveObligationIndexer({
      yellowstoneUrl: env.YELLOWSTONE_GRPC_URL || "",
      yellowstoneToken: env.YELLOWSTONE_X_TOKEN || "",
      programId,
      marketPubkey, // Filter by configured market
      rpcUrl: env.RPC_PRIMARY,
      reserveCache,
      oracleCache,
      bootstrapBatchSize: 100,
      bootstrapConcurrency: 5, // Higher concurrency for batch scoring
    });
    indexer.setCurrentSlotHint(currentSlot);

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
        // Select repay reserve: filter by allowlist (if set), then prefer USDC, otherwise take first available borrow
        const borrows = entry.decoded.borrows.filter((b) => b.reserve !== PublicKey.default.toString());
        if (borrows.length > 0) {
          // Extract reserve pubkeys from obligation borrows
          const borrowReserves = borrows.map((b) => b.reserve);
          
          // Lookup reserves using byReserve (not byMint which can have placeholder values)
          const borrowEntries = borrowReserves.map((rpk) => ({
            reservePubkey: rpk,
            entry: reserveCache.byReserve.get(rpk)
          }));
          
          const filteredBorrowEntries = allowedLiquidityMints
            ? borrowEntries.filter(be => be.entry && allowedLiquidityMints.has(be.entry.liquidityMint))
            : borrowEntries;
          
          // Prefer USDC borrow if available
          const usdcBorrow = filteredBorrowEntries.find((be) => be.entry && be.entry.liquidityMint === USDC_MINT);
          const selectedBorrow = usdcBorrow ?? filteredBorrowEntries.find((be) => be.entry) ?? null;
          
          if (selectedBorrow && selectedBorrow.entry) {
            repayReservePubkey = selectedBorrow.reservePubkey;
            primaryBorrowMint = selectedBorrow.entry.liquidityMint;
          }
        }
        
        // Select collateral reserve: filter by allowlist (if set), then prefer SOL, otherwise take first available deposit
        const deposits = entry.decoded.deposits.filter((d) => d.reserve !== PublicKey.default.toString());
        if (deposits.length > 0) {
          // Extract reserve pubkeys from obligation deposits
          const depositReserves = deposits.map((d) => d.reserve);
          
          // Lookup reserves using byReserve (not byMint which can have placeholder values)
          const depositEntries = depositReserves.map((rpk) => ({
            reservePubkey: rpk,
            entry: reserveCache.byReserve.get(rpk)
          }));
          
          const filteredDepositEntries = allowedLiquidityMints
            ? depositEntries.filter(de => de.entry && allowedLiquidityMints.has(de.entry.liquidityMint))
            : depositEntries;
          
          // Prefer SOL deposit if available
          const solDeposit = filteredDepositEntries.find((de) => de.entry && de.entry.liquidityMint === SOL_MINT);
          const selectedDeposit = solDeposit ?? filteredDepositEntries.find((de) => de.entry) ?? null;
          
          if (selectedDeposit && selectedDeposit.entry) {
            collateralReservePubkey = selectedDeposit.reservePubkey;
            primaryCollateralMint = selectedDeposit.entry.liquidityMint;
          }
        }
      }
      
      return {
        obligationPubkey: o.obligationPubkey,
        ownerPubkey: o.ownerPubkey,
        healthRatio: o.healthRatio,
        healthRatioRaw:
          (o as any).healthRatioHybridRaw ??
          o.healthRatioRecomputedRaw ??
          o.healthRatioProtocolRaw ??
          o.healthRatio,
        liquidationEligibleProtocol: o.liquidationEligibleProtocol,
        liquidationEligible: o.liquidationEligibleProtocol ?? o.liquidationEligible,
        borrowValueUsd: o.borrowValue,
        collateralValueUsd: o.collateralValue,
        repayReservePubkey,
        collateralReservePubkey,
        primaryBorrowMint,
        primaryCollateralMint,
        healthRatioRecomputed: o.healthRatioRecomputed,
        healthRatioRecomputedRaw: o.healthRatioRecomputedRaw,
        healthRatioProtocol: o.healthRatioProtocol,
        healthRatioProtocolRaw: o.healthRatioProtocolRaw,
        healthRatioDiff: o.healthRatioDiff,
        healthSource: o.healthSource,
        healthSourceUsed: o.healthSourceUsed,
        healthRatioHybrid: o.healthRatioHybrid,
        healthRatioHybridRaw: o.healthRatioHybridRaw,
        borrowValueRecomputed: o.borrowValueRecomputed,
        collateralValueRecomputed: o.collateralValueRecomputed,
        borrowValueProtocol: o.borrowValueProtocol,
        collateralValueProtocol: o.collateralValueProtocol,
        borrowValueHybrid: o.borrowValueHybrid,
        collateralValueHybrid: o.collateralValueHybrid,
        totalBorrowUsdRecomputed: o.totalBorrowUsdRecomputed,
        totalCollateralUsdRecomputed: o.totalCollateralUsdRecomputed,
        totalBorrowUsdAdjRecomputed: o.totalBorrowUsdAdjRecomputed,
        totalCollateralUsdAdjRecomputed: o.totalCollateralUsdAdjRecomputed,
        totalBorrowUsdProtocol: o.totalBorrowUsdProtocol,
        totalCollateralUsdProtocol: o.totalCollateralUsdProtocol,
        totalBorrowUsdAdjProtocol: o.totalBorrowUsdAdjProtocol,
        totalCollateralUsdAdjProtocol: o.totalCollateralUsdAdjProtocol,
        lastUpdateSlot: o.lastUpdateSlot,
        slotLag: o.slotLag,
        hybridDisabledReason: o.hybridDisabledReason,
      };
    });

    // Only emit candidates with BOTH repay/collateral legs present
    const candidatesWithBothLegs = scoredForSelection.filter(c => c.repayReservePubkey && c.collateralReservePubkey);

    if (scoredForSelection.length !== candidatesWithBothLegs.length) {
      logger.info(
        {
          totalScored: scoredForSelection.length,
          executable: candidatesWithBothLegs.length,
          filtered: scoredForSelection.length - candidatesWithBothLegs.length,
        },
        'Filtered candidates without executable legs'
      );
    }

    // Select and rank candidates
    logger.info("Selecting and ranking candidates...");
    const candidates = selectCandidates(candidatesWithBothLegs, { nearThreshold: nearArg });
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
      "Rank | Priority     | Distance | Liquidatable | Near Threshold | Borrow (adj) | Collateral (adj) | HR(chosen) | HR(proto) | HR(recomp) | ΔHR    | Obligation"
    );
    console.log("Note: Borrow/Collateral values are risk-adjusted (borrowFactor × USD, liquidationThreshold × USD)");
    console.log("-".repeat(190));

    topN.forEach((c, index) => {
      const rank = (index + 1).toString().padStart(4);
      const priorityStr = c.priorityScore.toFixed(2).padStart(12);
      const distanceStr = c.distanceToLiquidation.toFixed(4).padStart(8);
      const liquidatableStr = (c.liquidationEligible ? "YES" : "NO").padEnd(12);
      const nearThresholdStr = (c.predictedLiquidatableSoon ? "YES" : "NO").padEnd(14);
      const borrowValueStr = `$${c.borrowValueUsd.toFixed(2)}`.padStart(12);
      const collateralValueStr = `$${c.collateralValueUsd.toFixed(2)}`.padStart(16);
      const hrChosen = c.healthRatio.toFixed(4).padStart(10);
      const hrProto = ((c as any).healthRatioProtocol ?? 0).toFixed(4).padStart(9);
      const hrRecomp = ((c as any).healthRatioRecomputed ?? 0).toFixed(4).padStart(10);
      const hrDiff = ((c as any).healthRatioDiff ?? 0).toFixed(4).padStart(6);
      const obligationStr = c.obligationPubkey;

      console.log(
        `${rank} | ${priorityStr} | ${distanceStr} | ${liquidatableStr} | ${nearThresholdStr} | ${borrowValueStr} | ${collateralValueStr} | ${hrChosen} | ${hrProto} | ${hrRecomp} | ${hrDiff} | ${obligationStr}`
      );
    });

    console.log("\n");

    // PR: Add guardrails - report % of candidates with reserve pubkeys
    const withRepayReserve = topN.filter(c => c.repayReservePubkey).length;
    const withCollateralReserve = topN.filter(c => c.collateralReservePubkey).length;
    const withBothReserves = topN.filter(c => c.repayReservePubkey && c.collateralReservePubkey).length;
    
    console.log("=== RESERVE PUBKEY COVERAGE ===\n");
    
    // Guard against division by zero
    if (topN.length > 0) {
      const repayPct = ((withRepayReserve / topN.length) * 100).toFixed(1);
      const collateralPct = ((withCollateralReserve / topN.length) * 100).toFixed(1);
      const bothPct = ((withBothReserves / topN.length) * 100).toFixed(1);
      
      console.log(`Candidates with repayReservePubkey:      ${withRepayReserve}/${topN.length} (${repayPct}%)`);
      console.log(`Candidates with collateralReservePubkey: ${withCollateralReserve}/${topN.length} (${collateralPct}%)`);
      console.log(`Candidates with BOTH reserve pubkeys:    ${withBothReserves}/${topN.length} (${bothPct}%)`);
    } else {
      console.log("No candidates selected - skipping coverage statistics");
    }
    
    if (topN.length > 0 && withBothReserves < topN.length) {
      logger.warn(
        { 
          total: topN.length, 
          withBoth: withBothReserves, 
          missing: topN.length - withBothReserves 
        },
        "Some candidates missing reserve pubkeys - may cause execution failures"
      );
    } else {
      logger.info("All candidates have complete reserve pubkey information");
    }
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

          // Protocol SF cross-check
          const decoded = entry.decoded;
          const cAny = c as any;
          const SF_SCALE = 10n ** 18n;
          const sfToUsd = (raw: string | undefined): string => {
            try {
              return divBigintToNumber(BigInt(raw ?? '0'), SF_SCALE, 2).toFixed(2);
            } catch { return '0.00'; }
          };
          console.log('\n  Protocol SF Values:');
          console.log(`    Deposited Value (raw):          $${sfToUsd(decoded.depositedValueSfRaw)}`);
          console.log(`    Borrowed Assets Market (raw):   $${sfToUsd(decoded.borrowedAssetsMarketValueSfRaw)}`);
          console.log(`    Unhealthy Borrow Value (adj):   $${sfToUsd(decoded.unhealthyBorrowValueSfRaw)}`);
          console.log(`    Borrow Factor Adjusted (adj):   $${sfToUsd(decoded.borrowFactorAdjustedDebtValueSfRaw)}`);
          console.log(`    HR(protocol):                   ${(cAny.healthRatioProtocol ?? 0).toFixed(6)}`);
          console.log(`    HR(recomputed):                 ${(cAny.healthRatioRecomputed ?? 0).toFixed(6)}`);
          console.log(`    ΔHR (abs diff):                 ${(cAny.healthRatioDiff ?? 0).toFixed(6)}`);
          console.log(`    Liquidatable (chosen):         ${c.liquidationEligible ? 'YES' : 'NO'}`);
          console.log(`    Liquidatable (protocol):       ${cAny.liquidationEligibleProtocol === undefined ? 'n/a' : (cAny.liquidationEligibleProtocol ? 'YES' : 'NO')}`);
          console.log('\n  Parity (recomputed vs protocol):');
          console.log(`    Source used:                  ${(cAny.healthSourceUsed ?? 'n/a')}`);
          const borrowRawRatio = ratio(cAny.totalBorrowUsdRecomputed, cAny.totalBorrowUsdProtocol);
          console.log(`    Borrow raw ratio:             ${borrowRawRatio}`);
          console.log(`    Implied borrow inflation factor = Borrow raw ratio: ${borrowRawRatio}`);
          console.log(`    Collateral raw ratio:         ${ratio(cAny.totalCollateralUsdRecomputed, cAny.totalCollateralUsdProtocol)}`);
          console.log(`    Borrow adjusted ratio:        ${ratio(cAny.totalBorrowUsdAdjRecomputed, cAny.totalBorrowUsdAdjProtocol)}`);
          console.log(`    Collateral adjusted ratio:    ${ratio(cAny.totalCollateralUsdAdjRecomputed, cAny.totalCollateralUsdAdjProtocol)}`);
          if (cAny.hybridDisabledReason) {
            console.log(`    hybridDisabledReason:         ${cAny.hybridDisabledReason}`);
            console.log(`    NOTE: hybrid disabled; using pure recomputed forecast due to stale SF`);
          } else {
            const liqWeight = (cAny.totalCollateralUsdProtocol ?? 0) > 0
              ? (cAny.totalCollateralUsdAdjProtocol ?? 0) / cAny.totalCollateralUsdProtocol
              : 0;
            const bfWeight = (cAny.totalBorrowUsdProtocol ?? 0) > 0
              ? (cAny.totalBorrowUsdAdjProtocol ?? 0) / cAny.totalBorrowUsdProtocol
              : 0;
            const hybridCollateralAdj = (cAny.totalCollateralUsdRecomputed ?? 0) * liqWeight;
            const hybridBorrowAdj = (cAny.totalBorrowUsdRecomputed ?? 0) * bfWeight;
            const hybridHrCheck = hybridBorrowAdj > 0 ? (hybridCollateralAdj / hybridBorrowAdj) : 0;
            console.log(`    Recomputed totals used for hybrid: C_raw=${(cAny.totalCollateralUsdRecomputed ?? 0).toFixed(6)}, B_raw=${(cAny.totalBorrowUsdRecomputed ?? 0).toFixed(6)}`);
            console.log(`    Protocol weights used for hybrid: liqWeight=${liqWeight.toFixed(6)}, bfWeight=${bfWeight.toFixed(6)}`);
            console.log(`    Hybrid adjusted totals: C_adj=${hybridCollateralAdj.toFixed(6)}, B_adj=${hybridBorrowAdj.toFixed(6)}`);
            console.log(`    HR(hybrid):                   ${(cAny.healthRatioHybrid ?? 0).toFixed(6)}`);
            console.log(`    HR(hybrid raw):               ${(cAny.healthRatioHybridRaw ?? 0).toFixed(6)}`);
            console.log(`    HR(hybrid) check = (C_adj / B_adj): ${hybridHrCheck.toFixed(6)}`);
          }
          console.log(`    Obligation lastUpdateSlot:    ${c.lastUpdateSlot ?? 'n/a'}`);
          console.log(`    slotLag:                      ${cAny.slotLag ?? 'n/a'}`);

          if ((cAny.healthRatioDiff ?? 0) > 0.05) {
            console.log(`    ⚠️  Large ΔHR detected - possible edge case (elevation group, farms, etc.)`);
          }
          
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
