import type { OracleCache } from '../cache/oracleCache.js';
import type { ReserveCache } from '../cache/reserveCache.js';
import { USDC_MINT, USDT_MINT } from '../constants/mints.js';
import type { DecodedObligation } from '../kamino/types.js';
import { computeHealthRatio } from '../math/health.js';

export type TtlAssetClass = 'stable' | 'volatile';

export interface TtlLegContext {
  mint: string;
  usdRaw: number;
  usdWeighted: number;
  shareOfWeightedSide: number;
  assetClass: TtlAssetClass;
}

export interface PairAwareTtlContext {
  deposits: TtlLegContext[];
  borrows: TtlLegContext[];
  totalCollateralUsdAdj: number;
  totalBorrowUsdAdj: number;
  totalCollateralUsdRaw: number;
  totalBorrowUsdRaw: number;
  activeDepositCount: number;
  activeBorrowCount: number;
}

const STABLE_MINTS = new Set<string>([
  USDC_MINT,
  USDT_MINT,
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  '7XS55hUuoRrw1rUixhJv8o2zdX1kH31ZQAz1r4qAS8Fh', // USDH
]);

function getAssetClass(mint: string): TtlAssetClass {
  return STABLE_MINTS.has(mint) ? 'stable' : 'volatile';
}

export function buildPairAwareTtlContext(args: {
  decoded: DecodedObligation;
  reserveCache: ReserveCache;
  oracleCache: OracleCache;
}): PairAwareTtlContext | undefined {
  const result = computeHealthRatio({
    deposits: args.decoded.deposits,
    borrows: args.decoded.borrows,
    reserves: args.reserveCache.byMint,
    prices: args.oracleCache,
    options: { includeBreakdown: true, exposeRawHr: true },
  });

  if (!result.scored || !result.breakdown) {
    return undefined;
  }

  const totalDepositWeighted = result.breakdown.deposits.reduce((sum, leg) => sum + leg.usdWeighted, 0);
  const totalBorrowWeighted = result.breakdown.borrows.reduce((sum, leg) => sum + leg.usdWeighted, 0);

  const deposits: TtlLegContext[] = result.breakdown.deposits
    .map((leg) => ({
      mint: leg.liquidityMint,
      usdRaw: leg.usdRaw,
      usdWeighted: leg.usdWeighted,
      shareOfWeightedSide: totalDepositWeighted > 0 ? leg.usdWeighted / totalDepositWeighted : 0,
      assetClass: getAssetClass(leg.liquidityMint),
    }))
    .filter((leg) => leg.usdWeighted > 0 && leg.usdRaw > 0)
    .sort((a, b) => b.usdWeighted - a.usdWeighted);

  const borrows: TtlLegContext[] = result.breakdown.borrows
    .map((leg) => ({
      mint: leg.liquidityMint,
      usdRaw: leg.usdRaw,
      usdWeighted: leg.usdWeighted,
      shareOfWeightedSide: totalBorrowWeighted > 0 ? leg.usdWeighted / totalBorrowWeighted : 0,
      assetClass: getAssetClass(leg.liquidityMint),
    }))
    .filter((leg) => leg.usdWeighted > 0 && leg.usdRaw > 0)
    .sort((a, b) => b.usdWeighted - a.usdWeighted);

  return {
    deposits,
    borrows,
    totalCollateralUsdAdj: result.totalCollateralUsdAdj,
    totalBorrowUsdAdj: result.totalBorrowUsdAdj,
    totalCollateralUsdRaw: result.totalCollateralUsd,
    totalBorrowUsdRaw: result.totalBorrowUsd,
    activeDepositCount: deposits.length,
    activeBorrowCount: borrows.length,
  };
}
