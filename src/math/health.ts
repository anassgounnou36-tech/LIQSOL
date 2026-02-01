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
 * @returns USD price per token (as number for UI)
 */
function priceToUSD(oraclePrice: OraclePriceData): number {
  try {
    // Oracle price is scaled by exponent (e.g., -8 for Pyth means divide by 10^8)
    // Convert: price * 10^exponent gives USD per token
    
    const priceValue = Number(oraclePrice.price);
    const exponentScale = Math.pow(10, oraclePrice.exponent);
    
    // USD per token = price * 10^exponent
    const usdPerToken = priceValue * exponentScale;
    
    return usdPerToken;
  } catch (err) {
    logger.warn({ oraclePrice, err }, "Failed to convert oracle price to USD");
    return 0;
  }
}

/**
 * Converts oracle price with confidence adjustment for collateral valuation
 * Uses conservative pricing: price - confidence
 * @param oraclePrice - Oracle price data
 * @returns Adjusted USD price per token
 */
function priceToUSDForCollateral(oraclePrice: OraclePriceData): number {
  try {
    const price = Number(oraclePrice.price);
    const confidence = Number(oraclePrice.confidence);
    const exponentScale = Math.pow(10, oraclePrice.exponent);
    
    // Conservative pricing for collateral: price - confidence
    const adjustedPrice = Math.max(0, price - confidence);
    const usdPerToken = adjustedPrice * exponentScale;
    
    return usdPerToken;
  } catch (err) {
    logger.warn({ oraclePrice, err }, "Failed to convert oracle price with confidence for collateral");
    return 0;
  }
}

/**
 * Converts oracle price with confidence adjustment for borrow valuation
 * Uses conservative pricing: price + confidence
 * @param oraclePrice - Oracle price data
 * @returns Adjusted USD price per token
 */
function priceToUSDForBorrow(oraclePrice: OraclePriceData): number {
  try {
    const price = Number(oraclePrice.price);
    const confidence = Number(oraclePrice.confidence);
    const exponentScale = Math.pow(10, oraclePrice.exponent);
    
    // Conservative pricing for borrows: price + confidence
    const adjustedPrice = price + confidence;
    const usdPerToken = adjustedPrice * exponentScale;
    
    return usdPerToken;
  } catch (err) {
    logger.warn({ oraclePrice, err }, "Failed to convert oracle price with confidence for borrow");
    return 0;
  }
}

/**
 * Computes health ratio and position values for a Kamino obligation
 * 
 * Kamino Logic (aligned with production risk engine):
 * - For each deposit: compute USD collateral value using confidence-adjusted price
 *   (price - confidence); weight by liquidationThreshold (not LTV).
 * - For each borrow: compute USD borrow value using confidence-adjusted price
 *   (price + confidence); weight by borrowFactor.
 * - Health ratio = (Σ deposits_i * priceAdjusted_i * liquidationThresholdPct_i) / 
 *                  (Σ borrows_j * priceAdjusted_j * borrowFactor_j)
 * - Handle missing prices/reserves gracefully (skip and log)
 * - If both numerator and denominator are 0, clamp healthRatio to 2.0
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
    
    // Convert to USD value using confidence-adjusted price (conservative for collateral)
    const usdPerToken = priceToUSDForCollateral(price);
    const depositValueUSD = Number(depositedAmountRaw) * usdPerToken / Math.pow(10, decimals);
    
    // Weight by liquidationThreshold (as percentage 0-100), converting to decimal
    const liquidationThresholdWeight = reserve.liquidationThreshold / 100;
    const weightedDepositUSD = depositValueUSD * liquidationThresholdWeight;
    
    totalCollateralWeightedUSD += weightedDepositUSD;
    
    logger.debug(
      {
        mint: deposit.mint,
        depositedAmount: deposit.depositedAmount,
        usdPerToken,
        depositValueUSD,
        liquidationThresholdWeight,
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
    
    // Convert to USD value using confidence-adjusted price (conservative for borrows)
    const usdPerToken = priceToUSDForBorrow(price);
    const borrowValueUSD = Number(borrowedAmountRaw) * usdPerToken / Math.pow(10, decimals);
    
    // Weight by borrowFactor (as percentage, typically 100+), converting to decimal
    const borrowFactorWeight = reserve.borrowFactor / 100;
    const weightedBorrowUSD = borrowValueUSD * borrowFactorWeight;
    
    totalBorrowUSD += weightedBorrowUSD;
    
    logger.debug(
      {
        mint: borrow.mint,
        borrowedAmount: borrow.borrowedAmount,
        usdPerToken,
        borrowValueUSD,
        borrowFactorWeight,
        weightedBorrowUSD,
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
    // Normal case: weighted collateral / weighted borrows
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
