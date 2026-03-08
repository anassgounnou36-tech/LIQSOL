import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { OracleCache } from '../cache/oracleCache.js';
import type { ReserveCache, ReserveCacheEntry } from '../cache/reserveCache.js';
import type { DecodedObligation } from '../kamino/types.js';
import { SF_SCALE } from '../math/fractionScale.js';
import { buildPlanAwareEvContext } from '../predict/evContext.js';
import type { PlanAwareEvContext } from '../predict/evContext.js';
import { computeEVBreakdown, estimatePlanEv } from '../predict/evCalculator.js';

const sfFromRaw = (raw: bigint) => (raw * SF_SCALE).toString();

function makeReserveEntry(args: {
  reservePubkey: string;
  liquidityMint: string;
  collateralMint: string;
  liquidityDecimals: number;
  collateralDecimals: number;
  liquidationThreshold?: number;
  borrowFactor?: number;
  minLiquidationBonusBps?: number | null;
  maxLiquidationBonusBps?: number | null;
  protocolLiquidationFeePct?: number | null;
}): ReserveCacheEntry {
  return {
    reservePubkey: new PublicKey(args.reservePubkey),
    liquidityMint: args.liquidityMint,
    collateralMint: args.collateralMint,
    availableAmount: 1_000_000n,
    cumulativeBorrowRate: SF_SCALE,
    cumulativeBorrowRateBsfRaw: SF_SCALE,
    loanToValue: 75,
    liquidationThreshold: args.liquidationThreshold ?? 80,
    liquidationBonus: 800,
    minLiquidationBonusBps: args.minLiquidationBonusBps ?? null,
    maxLiquidationBonusBps: args.maxLiquidationBonusBps ?? null,
    protocolLiquidationFeePct: args.protocolLiquidationFeePct ?? null,
    borrowFactor: args.borrowFactor ?? 100,
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

function makePlanContext(overrides: Partial<PlanAwareEvContext> = {}): PlanAwareEvContext {
  return {
    selectedBorrowReservePubkey: 'borrow-reserve',
    selectedCollateralReservePubkey: 'collateral-reserve',
    selectedBorrowMint: 'borrow-mint',
    selectedCollateralMint: 'borrow-mint',
    selectedBorrowUsdRaw: 100,
    selectedBorrowUsdWeighted: 100,
    selectedCollateralUsdRaw: 500,
    selectedCollateralUsdWeighted: 400,
    totalBorrowUsdRaw: 400,
    totalBorrowUsdAdj: 400,
    totalCollateralUsdRaw: 800,
    totalCollateralUsdAdj: 640,
    minLiquidationBonusPct: 0.02,
    maxLiquidationBonusPct: 0.08,
    protocolLiquidationFeePct: 0,
    swapRequired: false,
    ...overrides,
  };
}

describe('plan realistic EV', () => {
  it('buildPlanAwareEvContext finds selected legs by reserve pubkey', () => {
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
      minLiquidationBonusBps: 200,
      maxLiquidationBonusBps: 900,
      protocolLiquidationFeePct: 15,
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

    const decoded: DecodedObligation = {
      obligationPubkey: 'obl',
      ownerPubkey: 'owner',
      marketPubkey: 'market',
      lastUpdateSlot: '1',
      deposits: [{ reserve: collateralReserve, mint: collateralCTokenMint, depositedAmount: '1000000000' }],
      borrows: [{ reserve: borrowReserve, mint: borrowMint, borrowedAmount: sfFromRaw(50_000_000n) }],
    };

    const evContext = buildPlanAwareEvContext({
      decoded,
      reserveCache,
      oracleCache,
      selectedBorrowReservePubkey: borrowReserve,
      selectedCollateralReservePubkey: collateralReserve,
      selectedBorrowMint: 'unused-borrow-mint',
      selectedCollateralMint: 'unused-collateral-mint',
    });

    expect(evContext).toBeDefined();
    expect(evContext?.selectedBorrowReservePubkey).toBe(borrowReserve);
    expect(evContext?.selectedCollateralReservePubkey).toBe(collateralReserve);
    expect(evContext?.selectedBorrowMint).toBe(borrowMint);
    expect(evContext?.selectedCollateralMint).toBe(collateralMint);
    expect(evContext?.minLiquidationBonusPct).toBeCloseTo(0.02, 8);
    expect(evContext?.maxLiquidationBonusPct).toBeCloseTo(0.09, 8);
    expect(evContext?.protocolLiquidationFeePct).toBeCloseTo(0.15, 8);
  });

  it('estimatePlanEv same-mint path uses selected-leg repay cap and zero same-mint slippage by default', () => {
    const estimate = estimatePlanEv(
      { borrowValueUsd: 400, healthRatioRaw: 0.95, evContext: makePlanContext({ selectedBorrowUsdRaw: 80 }) },
      1,
      {
        closeFactor: 0.5,
        liquidationBonusPct: 0.08,
        flashloanFeePct: 0.002,
        fixedGasUsd: 1,
      }
    );

    expect(estimate.breakdown.model).toBe('selected-leg-dynamic-bonus');
    expect(estimate.breakdown.repayCapUsd).toBeCloseTo(80, 8);
    expect(estimate.breakdown.slippageUsd).toBe(0);
    expect(estimate.breakdown.swapRequired).toBe(false);
  });

  it('estimatePlanEv cross-mint path applies cross-mint slippage buffer', () => {
    const estimate = estimatePlanEv(
      {
        borrowValueUsd: 200,
        healthRatioRaw: 0.9,
        evContext: makePlanContext({
          selectedBorrowUsdRaw: 100,
          selectedCollateralMint: 'other-mint',
          swapRequired: true,
        }),
      },
      1,
      {
        closeFactor: 0.5,
        liquidationBonusPct: 0.08,
        flashloanFeePct: 0.002,
        fixedGasUsd: 0.5,
        slippageBufferPct: 0.01,
      }
    );

    expect(estimate.breakdown.swapRequired).toBe(true);
    expect(estimate.breakdown.slippageUsd).toBeCloseTo(1, 8);
  });

  it('uses minimum liquidation bonus only for non-liquidatable candidates (hr >= 1)', () => {
    const estimate = estimatePlanEv(
      { borrowValueUsd: 300, healthRatioRaw: 1.02, evContext: makePlanContext() },
      1,
      {
        closeFactor: 0.5,
        liquidationBonusPct: 0.08,
        flashloanFeePct: 0.002,
        fixedGasUsd: 0.5,
      }
    );

    expect(estimate.breakdown.grossBonusPct).toBeCloseTo(0.02, 8);
  });

  it('interpolates liquidation bonus between min and max for liquidatable candidates', () => {
    const estimate = estimatePlanEv(
      { borrowValueUsd: 300, healthRatioRaw: 0.95, evContext: makePlanContext() },
      1,
      {
        closeFactor: 0.5,
        liquidationBonusPct: 0.08,
        flashloanFeePct: 0.002,
        fixedGasUsd: 0.5,
        bonusFullSeverityHrGap: 0.1,
      }
    );

    expect(estimate.breakdown.grossBonusPct).toBeCloseTo(0.05, 8);
  });

  it('applies protocol liquidation fee cut to net bonus', () => {
    const estimate = estimatePlanEv(
      {
        borrowValueUsd: 300,
        healthRatioRaw: 0.9,
        evContext: makePlanContext({ protocolLiquidationFeePct: 0.25 }),
      },
      1,
      {
        closeFactor: 0.5,
        liquidationBonusPct: 0.08,
        flashloanFeePct: 0.002,
        fixedGasUsd: 0.5,
      }
    );

    expect(estimate.breakdown.netBonusPct).toBeLessThan(estimate.breakdown.grossBonusPct);
  });

  it('caps collateral proceeds by selected collateral raw USD', () => {
    const estimate = estimatePlanEv(
      {
        borrowValueUsd: 300,
        healthRatioRaw: 0.8,
        evContext: makePlanContext({ selectedCollateralUsdRaw: 95, selectedBorrowUsdRaw: 100, totalBorrowUsdRaw: 1000 }),
      },
      1,
      {
        closeFactor: 0.5,
        liquidationBonusPct: 0.08,
        flashloanFeePct: 0.002,
        fixedGasUsd: 0.5,
      }
    );

    expect(estimate.breakdown.collateralProceedsUsd).toBe(95);
    expect(estimate.breakdown.profitUsd).toBe(0);
  });

  it('falls back to legacy-flat EV when evContext is missing', () => {
    const params = {
      closeFactor: 0.5,
      liquidationBonusPct: 0.05,
      flashloanFeePct: 0.002,
      fixedGasUsd: 0.5,
      slippageBufferPct: 0.01,
    };
    const hazard = 0.5;
    const estimate = estimatePlanEv({ borrowValueUsd: 1000, healthRatioRaw: 1.1 }, hazard, params);
    const legacy = computeEVBreakdown(1000, hazard, params);

    expect(estimate.breakdown.model).toBe('legacy-flat');
    expect(estimate.ev).toBeCloseTo(legacy.ev, 8);
  });
});
