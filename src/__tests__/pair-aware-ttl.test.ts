import { describe, expect, it } from 'vitest';
import { estimateTtl } from '../predict/ttlEstimator.js';
import type { PairAwareTtlContext } from '../predict/ttlContext.js';

const opts = {
  volatileMovePctPerMin: 0.2,
  stableMovePctPerMin: 0.02,
  maxMovePct: 50,
  legacySolDropPctPerMin: 0.2,
};

function makeContext(input: Partial<PairAwareTtlContext>): PairAwareTtlContext {
  return {
    deposits: [],
    borrows: [],
    totalCollateralUsdAdj: 110,
    totalBorrowUsdAdj: 100,
    totalCollateralUsdRaw: 110,
    totalBorrowUsdRaw: 100,
    activeDepositCount: 1,
    activeBorrowCount: 1,
    ...input,
  };
}

describe('pair-aware TTL estimator', () => {
  it('single deposit volatile and single borrow stable picks pair-collateral-shock with high confidence', () => {
    const ttl = estimateTtl(
      {
        healthRatioRaw: 1.1,
        ttlContext: makeContext({
          deposits: [
            {
              mint: 'So11111111111111111111111111111111111111112',
              usdRaw: 100,
              usdWeighted: 100,
              shareOfWeightedSide: 1,
              assetClass: 'volatile',
            },
          ],
          borrows: [
            {
              mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              usdRaw: 100,
              usdWeighted: 100,
              shareOfWeightedSide: 1,
              assetClass: 'stable',
            },
          ],
        }),
      },
      opts
    );

    expect(ttl.model).toBe('pair-collateral-shock');
    expect(ttl.ttlMinutes).not.toBeNull();
    expect(Number.isFinite(ttl.ttlMinutes ?? NaN)).toBe(true);
    expect(ttl.confidence).toBe('high');
  });

  it('single deposit stable and single borrow volatile picks pair-borrow-shock with high confidence', () => {
    const ttl = estimateTtl(
      {
        healthRatioRaw: 1.1,
        ttlContext: makeContext({
          deposits: [
            {
              mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              usdRaw: 100,
              usdWeighted: 100,
              shareOfWeightedSide: 1,
              assetClass: 'stable',
            },
          ],
          borrows: [
            {
              mint: 'So11111111111111111111111111111111111111112',
              usdRaw: 100,
              usdWeighted: 100,
              shareOfWeightedSide: 1,
              assetClass: 'volatile',
            },
          ],
        }),
      },
      opts
    );

    expect(ttl.model).toBe('pair-borrow-shock');
    expect(ttl.ttlMinutes).not.toBeNull();
    expect(Number.isFinite(ttl.ttlMinutes ?? NaN)).toBe(true);
    expect(ttl.confidence).toBe('high');
  });

  it('multi-leg context picks smallest valid minutes across deposit and borrow legs', () => {
    const ttl = estimateTtl(
      {
        healthRatioRaw: 1.12,
        ttlContext: makeContext({
          deposits: [
            {
              mint: 'So11111111111111111111111111111111111111112',
              usdRaw: 70,
              usdWeighted: 70,
              shareOfWeightedSide: 0.7,
              assetClass: 'volatile',
            },
            {
              mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
              usdRaw: 30,
              usdWeighted: 30,
              shareOfWeightedSide: 0.3,
              assetClass: 'volatile',
            },
          ],
          borrows: [
            {
              mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              usdRaw: 100,
              usdWeighted: 100,
              shareOfWeightedSide: 1,
              assetClass: 'stable',
            },
          ],
          totalCollateralUsdAdj: 112,
          totalBorrowUsdAdj: 100,
          activeDepositCount: 2,
          activeBorrowCount: 1,
        }),
      },
      opts
    );

    expect(ttl.model).toBe('pair-collateral-shock');
    expect(ttl.confidence === 'medium' || ttl.confidence === 'low').toBe(true);
    expect(ttl.confidence).toBe('medium');
  });

  it('falls back to legacy-global when ttlContext is missing', () => {
    const ttl = estimateTtl({ healthRatioRaw: 1.1 }, opts);
    expect(ttl.model).toBe('legacy-global');
    expect(ttl.ttlString).toBe('50m00s');
  });

  it('returns now when hr <= 1', () => {
    const ttl = estimateTtl({ healthRatioRaw: 1 }, opts);
    expect(ttl.ttlString).toBe('now');
    expect(ttl.ttlMinutes).toBe(0);
  });
});
