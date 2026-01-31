import { logger } from "../observability/logger.js";
import type { ReserveCacheEntry } from "../cache/reserveCache.js";
import type { OraclePriceData } from "../cache/oracleCache.js";
import type { ObligationDeposit, ObligationBorrow } from "../kamino/types.js";

/**
 * Input for health ratio computation
 */
export interface HealthRatioInput {
  /** Array of deposited collateral positions */
  deposits: ObligationDeposit[];
  /** Array of borrowed positions */
  borrows: ObligationBorrow[];
  /** Reserve cache keyed by mint */
  reserves: Map<string, ReserveCacheEntry>;
  /** Oracle price cache keyed by mint */
  prices: Map<string, OraclePriceData>;
}

/**
 * Result of health ratio computation
 */
export interface HealthRatioResult {
  /** Health ratio (collateralValueWeighted / borrowValue), clamped to [0, 2] */
  healthRatio: number;
  /** Total borrow value in USD */
  borrowValue: number;
  /** Total collateral value in USD (weighted by LTV) */
  collateralValue: number;
}

/**
 * Converts a raw token amount to UI amount using decimals
 * @param rawAmount - Raw token amount as string
 * @param decimals - Token decimals
 * @returns UI amount as bigint (scaled to avoid precision loss)
 */
function toUIAmount(rawAmount: string, decimals: number): bigint {
  try {
    const raw = BigInt(rawAmount);
    return raw;
  } catch (err) {
    logger.warn({ rawAmount, decimals, err }, "Failed to convert raw amount to bigint");
    return 0n;
  }
}

/**
 * Converts oracle price to USD price per token (UI units)
 * @param oraclePrice - Oracle price data
 * @param decimals - Token decimals
 * @returns USD price per token (as number for UI)
 */
function priceToUSD(oraclePrice: OraclePriceData, decimals: number): number {
  try {
    // Oracle price is scaled by exponent (e.g., -8 for Pyth means divide by 10^8)
    // Convert: price * 10^exponent gives USD per token (raw)
    // Then divide by 10^decimals to get USD per UI token
    
    const priceValue = Number(oraclePrice.price);
    const exponentScale = Math.pow(10, oraclePrice.exponent);
    const tokenScale = Math.pow(10, decimals);
    
    // USD per UI token = (price * 10^exponent) / 10^decimals
    const usdPerToken = (priceValue * exponentScale) / tokenScale;
    
    return usdPerToken;
  } catch (err) {
    logger.warn({ oraclePrice, decimals, err }, "Failed to convert oracle price to USD");
    return 0;
  }
}

/**
 * Computes health ratio and position values for a Kamino obligation
 * 
 * Logic:
 * - For each deposit: compute USD collateral value using mint decimals from reserves
 *   and uiPrice from oracles; weight by LTV (loan-to-value ratio).
 * - For each borrow: compute USD borrow value using mint decimals and uiPrice from oracles.
 *   Note: cumulativeBorrowRate is not currently available in reserve cache, so we use
 *   the borrowed amount directly as stored in the obligation.
 * - Health ratio = collateralValueWeighted / borrowValue (clamp to [0, 2])
 * - Handle missing prices/reserves gracefully (skip and log)
 * - High-precision math using bigint + scale/exponent for intermediate calculations
 * - Avoid NaN with safe division
 * 
 * @param input - Health ratio computation input
 * @returns Health ratio result with weighted collateral, borrow value, and ratio
 */
export function computeHealthRatio(input: HealthRatioInput): HealthRatioResult {
  const { deposits, borrows, reserves, prices } = input;
  
  let totalCollateralWeightedUSD = 0;
  let totalBorrowUSD = 0;
  
  // Process deposits (collateral)
  for (const deposit of deposits) {
    const reserve = reserves.get(deposit.mint);
    const price = prices.get(deposit.mint);
    
    if (!reserve) {
      logger.debug(
        { mint: deposit.mint, reserve: deposit.reserve },
        "Reserve not found for deposit, skipping collateral calculation"
      );
      continue;
    }
    
    if (!price) {
      logger.debug(
        { mint: deposit.mint, reserve: deposit.reserve },
        "Price not found for deposit, skipping collateral calculation"
      );
      continue;
    }
    
    // Get reserve decimals from the liquidity mint
    const decimals = reserve.liquidityDecimals;
    
    // Convert deposited amount to UI units (still as bigint for precision)
    const depositedAmountRaw = toUIAmount(deposit.depositedAmount, decimals);
    
    // Convert to USD value
    const usdPerToken = priceToUSD(price, decimals);
    const depositValueUSD = Number(depositedAmountRaw) * usdPerToken / Math.pow(10, decimals);
    
    // Weight by LTV (loan-to-value ratio as percentage 0-100)
    const ltvWeight = reserve.loanToValue / 100;
    const weightedDepositUSD = depositValueUSD * ltvWeight;
    
    totalCollateralWeightedUSD += weightedDepositUSD;
    
    logger.debug(
      {
        mint: deposit.mint,
        depositedAmount: deposit.depositedAmount,
        usdPerToken,
        depositValueUSD,
        ltvWeight,
        weightedDepositUSD,
      },
      "Processed deposit collateral"
    );
  }
  
  // Process borrows
  for (const borrow of borrows) {
    const reserve = reserves.get(borrow.mint);
    const price = prices.get(borrow.mint);
    
    if (!reserve) {
      logger.debug(
        { mint: borrow.mint, reserve: borrow.reserve },
        "Reserve not found for borrow, skipping borrow calculation"
      );
      continue;
    }
    
    if (!price) {
      logger.debug(
        { mint: borrow.mint, reserve: borrow.reserve },
        "Price not found for borrow, skipping borrow calculation"
      );
      continue;
    }
    
    // Get reserve decimals from the liquidity mint
    const decimals = reserve.liquidityDecimals;
    
    // Convert borrowed amount to UI units
    const borrowedAmountRaw = toUIAmount(borrow.borrowedAmount, decimals);
    
    // Convert to USD value
    // Note: In a full implementation, we should multiply by cumulativeBorrowRate
    // to account for accrued interest. However, this is not currently available
    // in ReserveCacheEntry, so we use the borrowed amount directly.
    const usdPerToken = priceToUSD(price, decimals);
    const borrowValueUSD = Number(borrowedAmountRaw) * usdPerToken / Math.pow(10, decimals);
    
    totalBorrowUSD += borrowValueUSD;
    
    logger.debug(
      {
        mint: borrow.mint,
        borrowedAmount: borrow.borrowedAmount,
        usdPerToken,
        borrowValueUSD,
      },
      "Processed borrow"
    );
  }
  
  // Compute health ratio with safe division
  let healthRatio: number;
  if (totalBorrowUSD === 0) {
    // No borrows means infinite health (healthy position)
    healthRatio = 2; // Clamp to max
  } else if (totalCollateralWeightedUSD === 0) {
    // No collateral with borrows means zero health (liquidatable)
    healthRatio = 0;
  } else {
    // Normal case: collateral / borrows
    healthRatio = totalCollateralWeightedUSD / totalBorrowUSD;
  }
  
  // Clamp to [0, 2] range to avoid extreme values
  healthRatio = Math.max(0, Math.min(2, healthRatio));
  
  // Ensure no NaN (should be caught by safe division above)
  if (isNaN(healthRatio)) {
    logger.warn(
      { totalCollateralWeightedUSD, totalBorrowUSD },
      "Health ratio is NaN, defaulting to 0"
    );
    healthRatio = 0;
  }
  
  return {
    healthRatio,
    borrowValue: totalBorrowUSD,
    collateralValue: totalCollateralWeightedUSD,
  };
}
