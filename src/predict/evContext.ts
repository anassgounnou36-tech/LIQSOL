import type { OracleCache } from '../cache/oracleCache.js';
import type { ReserveCache } from '../cache/reserveCache.js';
import type { DecodedObligation } from '../kamino/types.js';
import { computeHealthRatio } from '../math/health.js';

export interface EvLegContext {
  reservePubkey: string;
  mint: string;
  usdRaw: number;
  usdWeighted: number;
}

export interface PlanAwareEvContext {
  selectedBorrowReservePubkey: string;
  selectedCollateralReservePubkey: string;
  selectedBorrowMint: string;
  selectedCollateralMint: string;
  selectedBorrowUsdRaw: number;
  selectedBorrowUsdWeighted: number;
  selectedCollateralUsdRaw: number;
  selectedCollateralUsdWeighted: number;
  totalBorrowUsdRaw: number;
  totalBorrowUsdAdj: number;
  totalCollateralUsdRaw: number;
  totalCollateralUsdAdj: number;
  minLiquidationBonusPct: number | null;
  maxLiquidationBonusPct: number | null;
  protocolLiquidationFeePct: number | null;
  swapRequired: boolean;
}

export function buildPlanAwareEvContext(args: {
  decoded: DecodedObligation;
  reserveCache: ReserveCache;
  oracleCache: OracleCache;
  selectedBorrowReservePubkey?: string;
  selectedCollateralReservePubkey?: string;
  selectedBorrowMint?: string;
  selectedCollateralMint?: string;
}): PlanAwareEvContext | undefined {
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

  const selectedBorrowLeg =
    (args.selectedBorrowReservePubkey
      ? result.breakdown.borrows.find((leg) => leg.reservePubkey === args.selectedBorrowReservePubkey)
      : undefined) ??
    (args.selectedBorrowMint
      ? result.breakdown.borrows.find((leg) => leg.liquidityMint === args.selectedBorrowMint)
      : undefined);

  const selectedDepositLeg =
    (args.selectedCollateralReservePubkey
      ? result.breakdown.deposits.find((leg) => leg.reservePubkey === args.selectedCollateralReservePubkey)
      : undefined) ??
    (args.selectedCollateralMint
      ? result.breakdown.deposits.find((leg) => leg.liquidityMint === args.selectedCollateralMint)
      : undefined);

  if (!selectedBorrowLeg || !selectedDepositLeg) {
    return undefined;
  }

  const collateralReserve = args.reserveCache.byReserve.get(selectedDepositLeg.reservePubkey);
  const minLiquidationBonusPct =
    collateralReserve?.minLiquidationBonusBps != null
      ? collateralReserve.minLiquidationBonusBps / 10000
      : null;
  const maxLiquidationBonusPct =
    collateralReserve?.maxLiquidationBonusBps != null
      ? collateralReserve.maxLiquidationBonusBps / 10000
      : null;
  const protocolLiquidationFeePct =
    collateralReserve?.protocolLiquidationFeePct != null
      ? collateralReserve.protocolLiquidationFeePct / 100
      : null;

  return {
    selectedBorrowReservePubkey: selectedBorrowLeg.reservePubkey,
    selectedCollateralReservePubkey: selectedDepositLeg.reservePubkey,
    selectedBorrowMint: selectedBorrowLeg.liquidityMint,
    selectedCollateralMint: selectedDepositLeg.liquidityMint,
    selectedBorrowUsdRaw: selectedBorrowLeg.usdRaw,
    selectedBorrowUsdWeighted: selectedBorrowLeg.usdWeighted,
    selectedCollateralUsdRaw: selectedDepositLeg.usdRaw,
    selectedCollateralUsdWeighted: selectedDepositLeg.usdWeighted,
    totalBorrowUsdRaw: result.totalBorrowUsdRaw,
    totalBorrowUsdAdj: result.totalBorrowUsdAdj,
    totalCollateralUsdRaw: result.totalCollateralUsdRaw,
    totalCollateralUsdAdj: result.totalCollateralUsdAdj,
    minLiquidationBonusPct,
    maxLiquidationBonusPct,
    protocolLiquidationFeePct,
    swapRequired: selectedBorrowLeg.liquidityMint !== selectedDepositLeg.liquidityMint,
  };
}
