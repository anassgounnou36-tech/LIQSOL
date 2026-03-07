import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { OracleCache } from '../cache/oracleCache.js';
import type { ReserveCache, ReserveCacheEntry } from '../cache/reserveCache.js';
import type { DecodedObligation } from '../kamino/types.js';
import { SF_SCALE } from '../math/fractionScale.js';
import { RealtimeForecastUpdater } from '../monitoring/realtimeForecastUpdater.js';

const sfFromRaw = (raw: bigint) => (raw * SF_SCALE).toString();

function makeReserveEntry(args: {
  reservePubkey: string;
  liquidityMint: string;
  collateralMint: string;
  liquidityDecimals: number;
  collateralDecimals: number;
}): ReserveCacheEntry {
  return {
    reservePubkey: new PublicKey(args.reservePubkey),
    liquidityMint: args.liquidityMint,
    collateralMint: args.collateralMint,
    availableAmount: 1_000_000n,
    cumulativeBorrowRate: SF_SCALE,
    cumulativeBorrowRateBsfRaw: SF_SCALE,
    loanToValue: 75,
    liquidationThreshold: 80,
    liquidationBonus: 500,
    minLiquidationBonusBps: 200,
    maxLiquidationBonusBps: 900,
    protocolLiquidationFeePct: 10,
    borrowFactor: 100,
    oraclePubkeys: [PublicKey.unique()],
    liquidityDecimals: args.liquidityDecimals,
    collateralDecimals: args.collateralDecimals,
    scopePriceChain: null,
    scopeOraclePubkey: null,
    maxAgePriceSeconds: null,
    maxAgeTwapSeconds: null,
    collateralExchangeRateUi: 1,
  };
}

describe('RealtimeForecastUpdater EV context refresh', () => {
  it('rebuilds evContext when selected execution legs are known', () => {
    const borrowReserve = new PublicKey('11111111111111111111111111111111').toBase58();
    const collateralReserve = new PublicKey('So11111111111111111111111111111111111111112').toBase58();
    const borrowMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const collateralMint = 'So11111111111111111111111111111111111111112';
    const collateralCTokenMint = 'collateral-ctoken';

    const borrowEntry = makeReserveEntry({
      reservePubkey: borrowReserve,
      liquidityMint: borrowMint,
      collateralMint: 'borrow-ctoken',
      liquidityDecimals: 6,
      collateralDecimals: 6,
    });
    const collateralEntry = makeReserveEntry({
      reservePubkey: collateralReserve,
      liquidityMint: collateralMint,
      collateralMint: collateralCTokenMint,
      liquidityDecimals: 9,
      collateralDecimals: 9,
    });

    const reserveCache: ReserveCache = {
      byMint: new Map([
        [borrowMint, borrowEntry],
        [borrowEntry.collateralMint, borrowEntry],
        [collateralMint, collateralEntry],
        [collateralCTokenMint, collateralEntry],
      ]),
      byReserve: new Map([
        [borrowReserve, borrowEntry],
        [collateralReserve, collateralEntry],
      ]),
    };
    const oracleCache: OracleCache = new Map([
      [borrowMint, { price: 1_000_000n, confidence: 1n, slot: 1n, exponent: -6, oracleType: 'pyth' }],
      [collateralMint, { price: 100_000_000n, confidence: 1n, slot: 1n, exponent: -6, oracleType: 'pyth' }],
    ]);

    const updater = new RealtimeForecastUpdater({
      connection: {} as any,
      marketPubkey: PublicKey.unique(),
      programId: PublicKey.unique(),
      reserveCache,
      oracleCache,
    });
    const key = PublicKey.unique().toBase58();
    const decoded: DecodedObligation = {
      obligationPubkey: key,
      ownerPubkey: PublicKey.unique().toBase58(),
      marketPubkey: PublicKey.unique().toBase58(),
      lastUpdateSlot: '1',
      deposits: [{ reserve: collateralReserve, mint: collateralCTokenMint, depositedAmount: '1000000000' }],
      borrows: [{ reserve: borrowReserve, mint: borrowMint, borrowedAmount: sfFromRaw(50_000_000n) }],
    };

    (updater as any).decodedByKey.set(key, decoded);
    (updater as any).candidatesByKey.set(key, {
      key,
      obligationPubkey: key,
      repayReservePubkey: borrowReserve,
      collateralReservePubkey: collateralReserve,
      primaryBorrowMint: borrowMint,
      primaryCollateralMint: collateralMint,
    });

    (updater as any).recomputeCandidateLike(key);

    const refreshed = (updater as any).candidatesByKey.get(key);
    expect(refreshed.evContext).toBeDefined();
    expect(refreshed.evContext.selectedBorrowReservePubkey).toBe(borrowReserve);
    expect(refreshed.evContext.selectedCollateralReservePubkey).toBe(collateralReserve);
  });
});
