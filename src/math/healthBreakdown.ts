/**
 * Health Breakdown Module
 * 
 * Provides detailed health ratio explanations for validation purposes.
 * Shows per-leg USD breakdowns, prices, thresholds, and totals.
 */

import type { DecodedObligation } from "../kamino/types.js";
import type { ReserveCache } from "../cache/reserveCache.js";
import type { OracleCache } from "../cache/oracleCache.js";
import { divBigintToNumber } from "../utils/bn.js";

/**
 * Convert oracle mantissa to UI price using exponent
 */
function uiFromMantissa(mantissa: bigint, exponent: number): number {
  if (mantissa === 0n) return 0;
  
  if (exponent < 0) {
    // Divide by 10^(-exponent)
    const denom = 10n ** BigInt(-exponent);
    return divBigintToNumber(mantissa, denom);
  } else {
    // Multiply by 10^exponent
    const scaled = mantissa * (10n ** BigInt(exponent));
    return divBigintToNumber(scaled, 1n);
  }
}

export interface HealthBreakdownLeg {
  mint: string;               // collateral mint for deposits, liquidity mint for borrows
  underlyingMint?: string;    // for deposits only
  amountRaw: string;
  decimals: number;
  amountUi: number;
  priceUsd: number;
  usdValue: number;
  threshold?: number; // For deposits (liquidation threshold)
  factor?: number; // For borrows (borrow factor)
  weightedValue?: number; // threshold-weighted or factor-weighted value
}

export interface HealthBreakdown {
  deposits: HealthBreakdownLeg[];
  borrows: HealthBreakdownLeg[];
  totals: {
    collateralUsdRaw: number; // Sum of deposit USD values (unweighted)
    collateralUsdAdj: number; // Sum of deposit USD values weighted by liquidation threshold
    borrowUsdRaw: number; // Sum of borrow USD values (unweighted)
    borrowUsdAdj: number; // Sum of borrow USD values weighted by borrow factor
    healthRatio: number; // collateralUsdAdj / borrowUsdAdj
  };
  flags: {
    allowlist: boolean; // Whether allowlist mode is enabled
    missingLegs: number; // Number of legs that couldn't be valued
    approximations: string[]; // List of approximations made
  };
}

/**
 * Generate a detailed health breakdown for an obligation.
 * 
 * @param obligation Decoded obligation account
 * @param reserveCache Reserve cache with pricing/config data
 * @param oracleCache Oracle cache with current prices
 * @returns Detailed breakdown of health calculation
 */
export function explainHealth(
  obligation: DecodedObligation,
  reserveCache: ReserveCache,
  oracleCache: OracleCache
): HealthBreakdown {
  const deposits: HealthBreakdownLeg[] = [];
  const borrows: HealthBreakdownLeg[] = [];
  let collateralUsdRaw = 0;
  let collateralUsdAdj = 0;
  let borrowUsdRaw = 0;
  let borrowUsdAdj = 0;
  let missingLegs = 0;
  const approximations: string[] = [];

  // Process deposits (collateral)
  for (const deposit of obligation.deposits) {
    const reserve = reserveCache.byMint.get(deposit.mint);
    if (!reserve) {
      missingLegs++;
      approximations.push(`Missing reserve for deposit mint ${deposit.mint}`);
      continue;
    }

    // Price collateral using underlying liquidity mint
    const priceMint = reserve.liquidityMint;
    const oracle = oracleCache.get(priceMint);
    if (!oracle) {
      missingLegs++;
      approximations.push(`Missing oracle for underlying mint ${priceMint} (deposit collateral mint ${deposit.mint})`);
      continue;
    }

    // Get exchange rate for collateral token -> liquidity token conversion
    const exchangeRate = reserve.collateralExchangeRateUi;
    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
      missingLegs++;
      approximations.push(`Invalid exchange rate for deposit mint ${deposit.mint}`);
      continue;
    }

    // Convert deposited amount to UI units
    const amountRaw = BigInt(deposit.depositedAmount);
    const decimalsScale = 10n ** BigInt(reserve.collateralDecimals);
    const amountUi = divBigintToNumber(amountRaw, decimalsScale);
    
    // Convert to liquidity tokens using exchange rate
    const liquidityUi = amountUi * exchangeRate;
    
    // Calculate USD value
    const priceUsd = uiFromMantissa(oracle.price, oracle.exponent);
    const usdValue = liquidityUi * priceUsd;
    
    // Apply liquidation threshold (weight factor)
    const threshold = reserve.liquidationThreshold / 100; // Convert from percentage
    const weightedValue = usdValue * threshold;

    deposits.push({
      mint: deposit.mint,
      underlyingMint: reserve.liquidityMint,
      amountRaw: deposit.depositedAmount,
      decimals: reserve.collateralDecimals,
      amountUi: liquidityUi,
      priceUsd,
      usdValue,
      threshold,
      weightedValue,
    });

    collateralUsdRaw += usdValue;
    collateralUsdAdj += weightedValue;
  }

  // Process borrows
  for (const borrow of obligation.borrows) {
    const reserve = reserveCache.byMint.get(borrow.mint);
    if (!reserve) {
      missingLegs++;
      approximations.push(`Missing reserve for borrow mint ${borrow.mint}`);
      continue;
    }

    const oracle = oracleCache.get(borrow.mint);
    if (!oracle) {
      missingLegs++;
      approximations.push(`Missing oracle for borrow mint ${borrow.mint}`);
      continue;
    }

    // borrowedAmount is in SF (scaled fraction, 1e18-scaled)
    // Convert to UI units
    const borrowedSf = BigInt(borrow.borrowedAmount);
    const borrowedTokensRaw = borrowedSf / (10n ** 18n);
    const liquidityScale = 10n ** BigInt(reserve.liquidityDecimals);
    const amountUi = divBigintToNumber(borrowedTokensRaw, liquidityScale);

    // Calculate USD value
    const priceUsd = uiFromMantissa(oracle.price, oracle.exponent);
    const usdValue = amountUi * priceUsd;

    // Apply borrow factor (weight factor)
    const factor = reserve.borrowFactor / 100; // Convert from percentage
    const weightedValue = usdValue * factor;

    borrows.push({
      mint: borrow.mint,
      amountRaw: borrow.borrowedAmount,
      decimals: reserve.liquidityDecimals,
      amountUi,
      priceUsd,
      usdValue,
      factor,
      weightedValue,
    });

    borrowUsdRaw += usdValue;
    borrowUsdAdj += weightedValue;
  }

  // Calculate health ratio
  let healthRatio = borrowUsdAdj > 0 ? collateralUsdAdj / borrowUsdAdj : 2.0;
  
  // Clamp to [0, 2] to match PR7 health computation behavior
  // Values outside this range are logged for visibility
  if (healthRatio > 2.0) {
    approximations.push(`Health ratio ${healthRatio.toFixed(4)} clamped to 2.0 (well-collateralized)`);
    healthRatio = 2.0;
  } else if (healthRatio < 0) {
    approximations.push(`Health ratio ${healthRatio.toFixed(4)} clamped to 0.0 (invalid)`);
    healthRatio = 0.0;
  }

  // Check if allowlist is enabled (safely access process.env)
  let allowlist = false;
  try {
    allowlist = !!(globalThis as any).process?.env?.LIQSOL_LIQ_MINT_ALLOWLIST;
  } catch {
    // Ignore - defaults to false
  }

  return {
    deposits,
    borrows,
    totals: {
      collateralUsdRaw,
      collateralUsdAdj,
      borrowUsdRaw,
      borrowUsdAdj,
      healthRatio, // Already clamped above with approximation note if needed
    },
    flags: {
      allowlist,
      missingLegs,
      approximations,
    },
  };
}
