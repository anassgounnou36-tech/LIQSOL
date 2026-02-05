/**
 * Health Breakdown Module
 * 
 * Provides detailed health ratio explanations for validation purposes.
 * Shows per-leg USD breakdowns, prices, thresholds, and totals.
 * 
 * Uses computeHealthRatio() with breakdown enabled to ensure validation
 * matches the exact computation path used for scoring (PR7 health math).
 */

import type { DecodedObligation } from "../kamino/types.js";
import type { ReserveCache } from "../cache/reserveCache.js";
import type { OracleCache } from "../cache/oracleCache.js";
import { computeHealthRatio } from "./health.js";

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
    healthRatio: number; // collateralUsdAdj / borrowUsdAdj (clamped)
    healthRatioRaw?: number; // unclamped health ratio for debugging
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
 * This function now delegates to computeHealthRatio() with includeBreakdown enabled
 * to ensure validation uses the exact same computation path as scoring (PR7 health math).
 * No independent collateral conversion or pricing is performed here.
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
  // Use computeHealthRatio with breakdown enabled to ensure identical computation
  const result = computeHealthRatio({
    deposits: obligation.deposits,
    borrows: obligation.borrows,
    reserves: reserveCache.byMint,
    prices: oracleCache,
    options: {
      includeBreakdown: true,
      exposeRawHr: true,
    },
  });

  // Handle unscored case - no legs available
  if (!result.scored) {
    return {
      deposits: [],
      borrows: [],
      totals: {
        collateralUsdRaw: 0,
        collateralUsdAdj: 0,
        borrowUsdRaw: 0,
        borrowUsdAdj: 0,
        healthRatio: 0,
      },
      flags: {
        allowlist: false,
        missingLegs: 0,
        approximations: [`Failed to score: ${result.reason}`],
      },
    };
  }

  // Map breakdown to legacy format for compatibility
  const deposits: HealthBreakdownLeg[] = (result.breakdown?.deposits ?? []).map((d) => ({
    mint: d.collateralMint,
    underlyingMint: d.liquidityMint,
    amountRaw: "", // Not exposed in new format
    decimals: 0, // Not exposed in new format
    amountUi: d.underlyingUi,
    priceUsd: d.priceUsd,
    usdValue: d.usdRaw,
    threshold: d.usdWeighted / d.usdRaw, // Reverse-calculate threshold ratio
    weightedValue: d.usdWeighted,
  }));

  const borrows: HealthBreakdownLeg[] = (result.breakdown?.borrows ?? []).map((b) => ({
    mint: b.liquidityMint,
    amountRaw: "", // Not exposed in new format
    decimals: 0, // Not exposed in new format
    amountUi: b.borrowUi,
    priceUsd: b.priceUsd,
    usdValue: b.usdRaw,
    factor: b.usdWeighted / b.usdRaw, // Reverse-calculate factor ratio
    weightedValue: b.usdWeighted,
  }));

  // Check if allowlist is enabled (safely access process.env)
  let allowlist = false;
  try {
    allowlist = !!(globalThis as any).process?.env?.LIQSOL_LIQ_MINT_ALLOWLIST;
  } catch {
    // Ignore - defaults to false
  }

  const approximations: string[] = [];
  
  // Note if health ratio was clamped
  if (result.healthRatioRaw !== undefined && result.healthRatioRaw !== result.healthRatio) {
    approximations.push(
      `Health ratio ${result.healthRatioRaw.toFixed(4)} clamped to ${result.healthRatio.toFixed(4)}`
    );
  }

  return {
    deposits,
    borrows,
    totals: {
      collateralUsdRaw: result.totalCollateralUsd,
      collateralUsdAdj: result.totalCollateralUsdAdj,
      borrowUsdRaw: result.totalBorrowUsd,
      borrowUsdAdj: result.totalBorrowUsdAdj,
      healthRatio: result.healthRatio,
      healthRatioRaw: result.healthRatioRaw,
    },
    flags: {
      allowlist,
      missingLegs: 0,
      approximations,
    },
  };
}
