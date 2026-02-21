import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';
import { getConnection } from '../solana/connection.js';
import { loadReserves } from '../cache/reserveCache.js';
import { loadOracles } from '../cache/oracleCache.js';
import { LiveObligationIndexer } from '../engine/liveObligationIndexer.js';
import { selectCandidates, type ScoredObligation } from '../strategy/candidateSelector.js';
import { SOL_MINT, USDC_MINT } from '../constants/mints.js';
import { logger } from '../observability/logger.js';

export interface BuildCandidatesOptions {
  marketPubkey: PublicKey;
  programId: PublicKey;
  allowlistMints?: string[];
  topN?: number;
  nearThreshold?: number;
  outputPath?: string;
}

/**
 * Shared pipeline function to build candidates.json from obligations.jsonl
 * Uses existing scoring/allowlist logic from snapshotCandidates command
 */
export async function buildCandidates(options: BuildCandidatesOptions): Promise<void> {
  const {
    marketPubkey,
    programId,
    allowlistMints,
    topN = 50,
    nearThreshold = 1.02,
    outputPath = 'data/candidates.json',
  } = options;

  // Get connection from config
  const connection = getConnection();
  const rpcUrl = process.env.RPC_PRIMARY || '';
  const yellowstoneUrl = process.env.YELLOWSTONE_GRPC_URL || '';
  const yellowstoneToken = process.env.YELLOWSTONE_X_TOKEN || '';

  // Parse allowlist mints (execution-only filter)
  const allowedLiquidityMints = allowlistMints && allowlistMints.length > 0 
    ? new Set(allowlistMints) 
    : undefined;

  if (allowedLiquidityMints) {
    logger.info({ allowlistMints }, 'Execution allowlist enabled (repay/collateral leg selection only)');
  } else {
    logger.info('Execution allowlist disabled - any mint allowed for leg selection');
  }

  // Load reserves/oracles over FULL market (no allowlist for scoring)
  logger.info('Loading reserves for market...');
  const reserveCache = await loadReserves(connection, marketPubkey, undefined);
  logger.info({ reserveCount: reserveCache.byReserve.size }, 'Reserves loaded');

  logger.info('Loading oracles...');
  const oracleCache = await loadOracles(connection, reserveCache, undefined);
  logger.info({ oracleCount: oracleCache.size }, 'Oracles loaded');

  // Create indexer WITHOUT allowlist (scoring must see full portfolio)
  const indexer = new LiveObligationIndexer({
    yellowstoneUrl,
    yellowstoneToken,
    programId,
    marketPubkey,
    rpcUrl,
    reserveCache,
    oracleCache,
    bootstrapBatchSize: 100,
    bootstrapConcurrency: 5,
  });

  // Load snapshot and bootstrap
  logger.info('Loading obligation snapshot and computing health scores...');
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
    'Bootstrap completed'
  );

  // Get all scored obligations
  const scoredObligations = indexer.getScoredObligations();

  if (scoredObligations.length === 0) {
    logger.warn('No scored obligations found. Ensure reserves and oracles are loaded correctly.');
    return;
  }

  // Map to ScoredObligation interface for candidate selector
  // Enrich with reserve pubkeys from obligation borrows/deposits
  const scoredForSelection: ScoredObligation[] = scoredObligations.map((o) => {
    const entry = indexer.getObligationEntry(o.obligationPubkey);
    
    let repayReservePubkey: string | undefined;
    let collateralReservePubkey: string | undefined;
    let primaryBorrowMint: string | undefined;
    let primaryCollateralMint: string | undefined;
    
    if (entry && entry.decoded) {
      // Select repay reserve: filter by allowlist (if set), then prefer USDC, otherwise take first available borrow
      const borrows = entry.decoded.borrows.filter((b) => b.reserve !== PublicKey.default.toString());
      if (borrows.length > 0) {
        const borrowReserves = borrows.map((b) => b.reserve);
        const borrowEntries = borrowReserves.map((rpk) => ({
          reservePubkey: rpk,
          entry: reserveCache.byReserve.get(rpk)
        }));
        
        const filteredBorrowEntries = allowedLiquidityMints
          ? borrowEntries.filter(be => be.entry && allowedLiquidityMints.has(be.entry.liquidityMint))
          : borrowEntries;
        
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
        const depositReserves = deposits.map((d) => d.reserve);
        const depositEntries = depositReserves.map((rpk) => ({
          reservePubkey: rpk,
          entry: reserveCache.byReserve.get(rpk)
        }));
        
        const filteredDepositEntries = allowedLiquidityMints
          ? depositEntries.filter(de => de.entry && allowedLiquidityMints.has(de.entry.liquidityMint))
          : depositEntries;
        
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
      borrowValueRecomputed: o.borrowValueRecomputed,
      collateralValueRecomputed: o.collateralValueRecomputed,
      borrowValueProtocol: o.borrowValueProtocol,
      collateralValueProtocol: o.collateralValueProtocol,
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
  logger.info('Selecting and ranking candidates...');
  const candidates = selectCandidates(candidatesWithBothLegs, { nearThreshold });
  const topCandidates = candidates.slice(0, topN);

  // Report statistics
  const candLiquidatable = candidates.filter(c => c.liquidationEligible).length;
  const candNear = candidates.filter(c => c.predictedLiquidatableSoon).length;

  logger.info(
    { 
      scoredCount: scoredObligations.length, 
      topCount: topCandidates.length,
      liquidatable: candLiquidatable,
      nearThreshold: candNear,
    },
    'Candidates selected'
  );

  // Check reserve pubkey coverage (should always be 100% after filtering)
  const withBothReserves = topCandidates.filter(c => c.repayReservePubkey && c.collateralReservePubkey).length;
  
  if (topCandidates.length > 0 && withBothReserves < topCandidates.length) {
    logger.warn(
      { 
        total: topCandidates.length, 
        withBoth: withBothReserves, 
        missing: topCandidates.length - withBothReserves 
      },
      'Some candidates missing reserve pubkeys - may cause execution failures'
    );
  } else if (topCandidates.length > 0) {
    logger.info('All candidates have complete reserve pubkey information');
  }

  // Write output
  const outPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ candidates: topCandidates }, null, 2));
  logger.info({ path: outPath, count: topCandidates.length }, 'Candidate data written to JSON file');
}
