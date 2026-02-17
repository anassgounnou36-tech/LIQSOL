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

  // Parse allowlist mints
  const allowedLiquidityMints = allowlistMints && allowlistMints.length > 0 
    ? new Set(allowlistMints) 
    : undefined;

  if (allowedLiquidityMints) {
    logger.info({ allowlistMints }, 'Allowlist mode enabled - filtering by liquidity mints');
  } else {
    logger.info('Allowlist mode disabled - scoring all obligations');
  }

  // Load reserves with allowlist filtering
  logger.info('Loading reserves for market...');
  const reserveCache = await loadReserves(connection, marketPubkey, allowedLiquidityMints);
  logger.info({ reserveCount: reserveCache.byReserve.size }, 'Reserves loaded');

  // Load oracles
  logger.info('Loading oracles...');
  const oracleCache = await loadOracles(connection, reserveCache, allowedLiquidityMints);
  logger.info({ oracleCount: oracleCache.size }, 'Oracles loaded');

  // Create indexer with caches but without Yellowstone (bootstrap only)
  const indexer = new LiveObligationIndexer({
    yellowstoneUrl,
    yellowstoneToken,
    programId,
    marketPubkey,
    rpcUrl,
    reserveCache,
    oracleCache,
    allowedLiquidityMints,
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
      // Select repay reserve: prefer USDC, otherwise take first borrow
      const borrows = entry.decoded.borrows.filter((b) => b.reserve !== PublicKey.default.toString());
      if (borrows.length > 0) {
        const borrowReserves = borrows.map((b) => b.reserve);
        const borrowEntries = borrowReserves.map((rpk) => ({
          reservePubkey: rpk,
          entry: reserveCache.byReserve.get(rpk)
        }));
        
        const usdcBorrow = borrowEntries.find((be) => be.entry && be.entry.liquidityMint === USDC_MINT);
        const selectedBorrow = usdcBorrow ?? borrowEntries.find((be) => be.entry) ?? null;
        
        if (selectedBorrow && selectedBorrow.entry) {
          repayReservePubkey = selectedBorrow.reservePubkey;
          primaryBorrowMint = selectedBorrow.entry.liquidityMint;
        } else {
          repayReservePubkey = borrowReserves[0];
          primaryBorrowMint = borrows[0].mint;
          logger.warn(
            { obligationPubkey: o.obligationPubkey, repayReservePubkey },
            'Repay reserve not found in cache - using reserve pubkey with placeholder mint'
          );
        }
      }
      
      // Select collateral reserve: prefer SOL, otherwise take first deposit
      const deposits = entry.decoded.deposits.filter((d) => d.reserve !== PublicKey.default.toString());
      if (deposits.length > 0) {
        const depositReserves = deposits.map((d) => d.reserve);
        const depositEntries = depositReserves.map((rpk) => ({
          reservePubkey: rpk,
          entry: reserveCache.byReserve.get(rpk)
        }));
        
        const solDeposit = depositEntries.find((de) => de.entry && de.entry.liquidityMint === SOL_MINT);
        const selectedDeposit = solDeposit ?? depositEntries.find((de) => de.entry) ?? null;
        
        if (selectedDeposit && selectedDeposit.entry) {
          collateralReservePubkey = selectedDeposit.reservePubkey;
          primaryCollateralMint = selectedDeposit.entry.liquidityMint;
        } else {
          collateralReservePubkey = depositReserves[0];
          primaryCollateralMint = deposits[0].mint;
          logger.warn(
            { obligationPubkey: o.obligationPubkey, collateralReservePubkey },
            'Collateral reserve not found in cache - using reserve pubkey with placeholder mint'
          );
        }
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
  logger.info('Selecting and ranking candidates...');
  const candidates = selectCandidates(scoredForSelection, { nearThreshold });
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

  // Check reserve pubkey coverage
  const withRepayReserve = topCandidates.filter(c => c.repayReservePubkey).length;
  const withCollateralReserve = topCandidates.filter(c => c.collateralReservePubkey).length;
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
  } else {
    logger.info('All candidates have complete reserve pubkey information');
  }

  // Write output
  const outPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ candidates: topCandidates }, null, 2));
  logger.info({ path: outPath, count: topCandidates.length }, 'Candidate data written to JSON file');
}
