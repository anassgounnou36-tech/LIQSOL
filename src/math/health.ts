import type { ReserveCacheEntry } from "../cache/reserveCache.js";
import type { OraclePriceData } from "../cache/oracleCache.js";
import type { ObligationDeposit, ObligationBorrow } from "../kamino/types.js";

/**
 * Known stablecoin mints for price clamping
 */
const STABLECOIN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT (old)
  "Es9vMFrzaCERZz7zV1bG8gNBr2F9Wq8jqfZ3Wfz3BfQx", // USDT (new)
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
  "7XS55hUuoRrw1rUixhJv8o2zdX1kH31ZQAz1r4qAS8Fh", // USDH
]);

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
 * Result of health ratio computation - discriminated union for scored vs unscored
 */
export type HealthRatioResult =
  | {
      /** Obligation was successfully scored */
      scored: true;
      /** Health ratio (collateralValueWeighted / borrowValue), clamped to [0, 2] */
      healthRatio: number;
      /** Total borrow value in USD */
      borrowValue: number;
      /** Total collateral value in USD (weighted by liquidationThreshold) */
      collateralValue: number;
    }
  | {
      /** Obligation could not be scored */
      scored: false;
      /** Reason why the obligation was not scored */
      reason: "MISSING_RESERVE" | "MISSING_ORACLE_PRICE" | "MISSING_EXCHANGE_RATE" | "INVALID_MATH" | "OTHER_MARKET";
    };

/**
 * Check if a mint is a known stablecoin
 */
function isStableMint(mint: string): boolean {
  return STABLECOIN_MINTS.has(mint);
}

/**
 * Parse collateral exchange rate from BSF string to UI rate
 * Returns null if missing, zero, or invalid
 */
function parseExchangeRateUi(
  collateralExchangeRateBsf: string | undefined | null
): number | null {
  if (!collateralExchangeRateBsf) return null;
  
  const scaled = Number(collateralExchangeRateBsf);
  if (!Number.isFinite(scaled) || scaled <= 0) return null;
  
  // BigFraction is typically in 1e18 scale
  // This converts deposit notes (cTokens) to underlying tokens
  const rate = scaled / (10 ** 18);
  return rate > 0 ? rate : null;
}

/**
 * Convert borrowedAmountSf (scaled fraction) to UI units
 * Returns 0 for invalid/missing values
 */
function convertBorrowSfToUi(
  borrowedAmountSf: string | undefined | null,
  liquidityDecimals: number
): number {
  if (!borrowedAmountSf) return 0;
  
  const num = Number(borrowedAmountSf);
  if (!Number.isFinite(num) || num < 0) return 0;
  
  // Divide by 10^decimals to convert to UI units
  return num / (10 ** liquidityDecimals);
}

/**
 * Convert mantissa to UI price using exponent
 * Returns null if result is NaN or Infinity
 */
function uiFromMantissa(price: bigint, exponent: number): number | null {
  const result = Number(price) * Math.pow(10, exponent);
  if (!isFinite(result)) {
    return null;
  }
  return result;
}

/**
 * Apply confidence adjustment and stablecoin clamping
 * Returns null if inputs are not finite or result is invalid
 * 
 * @param mint - Token mint address
 * @param basePrice - Base price in UI units
 * @param confidence - Confidence in UI units
 * @param side - Whether this is for collateral or borrow valuation
 * @returns Adjusted price or null if invalid
 */
function adjustedUiPrice(
  mint: string,
  basePrice: number,
  confidence: number,
  side: "collateral" | "borrow"
): number | null {
  // Check for invalid inputs
  if (!isFinite(basePrice) || !isFinite(confidence)) {
    return null;
  }
  
  // Apply confidence adjustment
  const adjustedPrice = side === "collateral" 
    ? Math.max(0, basePrice - confidence)
    : basePrice + confidence;
  
  // Check for invalid result
  if (!isFinite(adjustedPrice)) {
    return null;
  }
  
  // Apply stablecoin clamp [0.99, 1.01]
  if (isStableMint(mint)) {
    return Math.min(1.01, Math.max(0.99, adjustedPrice));
  }
  
  return adjustedPrice;
}

/**
 * Computes health ratio and position values for a Kamino obligation
 * 
 * Returns a discriminated union:
 * - { scored: true, healthRatio, borrowValue, collateralValue } on success
 * - { scored: false, reason } when data is missing or invalid
 * 
 * This prevents treating missing data as "$0 collateral" and enables
 * proper aggregation of unscored reasons without per-deposit spam logs.
 * 
 * @param input - Health ratio computation input
 * @returns Health ratio result or unscored with reason
 */
export function computeHealthRatio(input: HealthRatioInput): HealthRatioResult {
  const { deposits, borrows, reserves, prices } = input;
  
  let collateralUSD = 0;
  let borrowUSD = 0;
  
  // Process deposits (collateral)
  for (const deposit of deposits) {
    const reserve = reserves.get(deposit.mint);
    if (!reserve) {
      return { scored: false, reason: "MISSING_RESERVE" };
    }
    
    const oraclePrice = prices.get(deposit.mint);
    if (!oraclePrice) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Staleness guard: skip if timestamp/slot is zero
    if (Number(oraclePrice.slot) <= 0) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Convert price and confidence to UI units
    const baseUi = uiFromMantissa(oraclePrice.price, oraclePrice.exponent);
    const confUi = uiFromMantissa(oraclePrice.confidence, oraclePrice.exponent);
    
    if (baseUi === null || confUi === null) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Apply confidence adjustment and stablecoin clamping for collateral
    const priceUi = adjustedUiPrice(deposit.mint, baseUi, confUi, "collateral");
    
    if (priceUi === null || priceUi <= 0) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Parse exchange rate: if missing or zero, mark unscored (not $0 collateral)
    const exchangeRateUi = parseExchangeRateUi(
      reserve.collateralExchangeRateBsf.toString()
    );
    
    if (exchangeRateUi === null || exchangeRateUi <= 0) {
      return { scored: false, reason: "MISSING_EXCHANGE_RATE" };
    }
    
    // Convert deposit notes to underlying tokens
    const depositedNotes = Number(deposit.depositedAmount);
    if (!Number.isFinite(depositedNotes) || depositedNotes < 0) {
      return { scored: false, reason: "INVALID_MATH" };
    }
    
    // Normalize to UI units using liquidity decimals
    const depositUi = (depositedNotes / (10 ** reserve.liquidityDecimals)) * exchangeRateUi;
    
    // Apply liquidation threshold weight
    const weight = reserve.liquidationThreshold / 100;
    const valueUSD = depositUi * priceUi * weight;
    
    if (!Number.isFinite(valueUSD)) {
      return { scored: false, reason: "INVALID_MATH" };
    }
    
    collateralUSD += Math.max(0, valueUSD);
  }
  
  // Process borrows
  for (const borrow of borrows) {
    const reserve = reserves.get(borrow.mint);
    if (!reserve) {
      return { scored: false, reason: "MISSING_RESERVE" };
    }
    
    const oraclePrice = prices.get(borrow.mint);
    if (!oraclePrice) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Staleness guard
    if (Number(oraclePrice.slot) <= 0) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Convert price and confidence to UI units
    const baseUi = uiFromMantissa(oraclePrice.price, oraclePrice.exponent);
    const confUi = uiFromMantissa(oraclePrice.confidence, oraclePrice.exponent);
    
    if (baseUi === null || confUi === null) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Apply confidence adjustment and stablecoin clamping for borrow
    const priceUi = adjustedUiPrice(borrow.mint, baseUi, confUi, "borrow");
    
    if (priceUi === null || priceUi <= 0) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Convert SF to UI units using safe helper
    const borrowUi = convertBorrowSfToUi(borrow.borrowedAmount, reserve.liquidityDecimals);
    
    if (!Number.isFinite(borrowUi)) {
      return { scored: false, reason: "INVALID_MATH" };
    }
    
    // Apply borrow factor (defaults to 100 = 1.0x)
    const borrowFactor = (reserve.borrowFactor ?? 100) / 100;
    const valueUSD = borrowUi * priceUi * borrowFactor;
    
    if (!Number.isFinite(valueUSD)) {
      return { scored: false, reason: "INVALID_MATH" };
    }
    
    borrowUSD += Math.max(0, valueUSD);
  }
  
  // Calculate health ratio
  let ratio: number;
  if (borrowUSD <= 0 && collateralUSD <= 0) {
    // Empty position
    ratio = 2.0;
  } else if (borrowUSD <= 0) {
    // No debt, maximum health
    ratio = 2.0;
  } else if (collateralUSD <= 0) {
    // No collateral, unhealthy
    ratio = 0.0;
  } else {
    // Normal calculation
    ratio = collateralUSD / borrowUSD;
  }
  
  // Clamp to [0, 2]
  ratio = Math.max(0, Math.min(2, ratio));
  
  // Final sanity check
  if (!Number.isFinite(ratio)) {
    return { scored: false, reason: "INVALID_MATH" };
  }
  
  return {
    scored: true,
    healthRatio: ratio,
    borrowValue: borrowUSD,
    collateralValue: collateralUSD,
  };
}
