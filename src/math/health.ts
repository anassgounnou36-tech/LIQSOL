import type { ReserveCacheEntry } from "../cache/reserveCache.js";
import type { OraclePriceData } from "../cache/oracleCache.js";
import type { ObligationDeposit, ObligationBorrow } from "../kamino/types.js";
import { divBigintToNumber } from "../utils/bn.js";
import { logger } from "../observability/logger.js";

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
 * BigFractionBytes scale (18 decimals)
 */
const BSF_SCALE = 10n ** 18n;

/**
 * Gate spammy exchange rate warnings behind environment flag
 * Safely check for process.env without TypeScript errors
 */
let VERBOSE_EXCHANGE_RATE = false;
try {
  VERBOSE_EXCHANGE_RATE = (globalThis as any).process?.env?.LIQSOL_VERBOSE_EXCHANGE_RATE === "1";
} catch {
  // Ignore - defaults to false
}

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
 * Convert collateral exchange rate BSF string to UI number using bigint-safe math
 * Returns null if missing, zero, or invalid
 */
function exchangeRateUiFromBsfString(bsfStr: string | undefined | null): number | null {
  if (!bsfStr) return null;
  
  try {
    const bsf = BigInt(bsfStr);
    if (bsf <= 0n) return null;
    
    // Use bigint-safe division to preserve precision
    const rate = divBigintToNumber(bsf, BSF_SCALE, 18);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

/**
 * Convert borrowedAmountSf (scaled fraction) to UI units using bigint-safe math
 * Returns 0 for invalid/missing values
 */
function convertBorrowSfToUi(
  borrowedAmountSf: string | undefined | null,
  liquidityDecimals: number
): number {
  if (!borrowedAmountSf) return 0;
  
  try {
    const borrowedRaw = BigInt(borrowedAmountSf);
    if (borrowedRaw < 0n) return 0;
    
    const liquidityScale = 10n ** BigInt(liquidityDecimals);
    const borrowedUi = divBigintToNumber(borrowedRaw, liquidityScale, liquidityDecimals);
    
    return Number.isFinite(borrowedUi) && borrowedUi >= 0 ? borrowedUi : 0;
  } catch {
    return 0;
  }
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
    const exchangeRateUi = exchangeRateUiFromBsfString(
      reserve.collateralExchangeRateBsf.toString()
    );
    
    if (exchangeRateUi === null || exchangeRateUi <= 0) {
      // Gate warning behind environment flag to avoid spam
      if (VERBOSE_EXCHANGE_RATE) {
        logger.warn(
          { mint: deposit.mint, reserve: deposit.reserve },
          "Collateral exchange rate is zero or invalid, skipping deposit"
        );
      }
      return { scored: false, reason: "MISSING_EXCHANGE_RATE" };
    }
    
    // Convert deposit notes to underlying tokens using bigint-safe math
    let depositedNotesRaw: bigint;
    try {
      depositedNotesRaw = BigInt(deposit.depositedAmount);
    } catch {
      return { scored: false, reason: "INVALID_MATH" };
    }
    
    if (depositedNotesRaw < 0n) {
      return { scored: false, reason: "INVALID_MATH" };
    }
    
    // Normalize deposit notes using COLLATERAL decimals (not liquidity decimals)
    // depositedAmount is in collateral token units
    const collateralScale = 10n ** BigInt(reserve.collateralDecimals);
    const depositedNotesUi = divBigintToNumber(
      depositedNotesRaw,
      collateralScale,
      reserve.collateralDecimals
    );
    
    // Convert to underlying liquidity units using exchange rate
    const depositUi = depositedNotesUi * exchangeRateUi;
    
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
