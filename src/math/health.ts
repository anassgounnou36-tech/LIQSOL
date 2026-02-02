import { logger } from "../observability/logger.js";
import type { ReserveCacheEntry } from "../cache/reserveCache.js";
import type { OraclePriceData } from "../cache/oracleCache.js";
import type { ObligationDeposit, ObligationBorrow } from "../kamino/types.js";
import { divBigintToNumber } from "../utils/bn.js";
import { divBigintToNumber } from "../utils/bn.js";

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
 * Tolerance for clamping tiny negative floating-point artifacts to zero.
 * These artifacts can occur from precision parameter (18) in bigint division.
 */
const FLOATING_POINT_TOLERANCE = 1e-18;

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
  /** Health ratio (collateralValueWeighted / borrowValue), clamped to [0, 2], or null if unscored */
  healthRatio: number | null;
  /** Total borrow value in USD */
  borrowValue: number;
  /** Total collateral value in USD (weighted by liquidationThreshold) */
  collateralValue: number;
}

/**
 * Check if a mint is a known stablecoin
 */
function isStableMint(mint: string): boolean {
  return STABLECOIN_MINTS.has(mint);
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
 * Kamino Logic (aligned with production risk engine):
 * - For each deposit: compute USD collateral value using confidence-adjusted price
 *   (price - confidence); weight by liquidationThreshold (not LTV).
 * - For each borrow: compute USD borrow value using confidence-adjusted price
 *   (price + confidence); weight by borrowFactor.
 * - Health ratio = (Σ deposits_i * priceAdjusted_i * liquidationThresholdPct_i) / 
 *                  (Σ borrows_j * priceAdjusted_j * borrowFactor_j)
 * - Handle missing prices/reserves gracefully (skip and log)
 * - Apply staleness guard: skip if slot/timestamp is 0
 * - Apply stablecoin clamping to prices
 * - If both numerator and denominator are 0, clamp healthRatio to 2.0
 * - Clamp final ratio to [0, 2]
 * 
 * @param input - Health ratio computation input
 * @returns Health ratio result with weighted collateral, borrow value, and ratio
 */
export function computeHealthRatio(input: HealthRatioInput): HealthRatioResult {
  const { deposits, borrows, reserves, prices } = input;
  
  let collateralUSD = 0;
  let borrowUSD = 0;
  let scored = true; // Track if we have sufficient data to score
  
  // Process deposits (collateral)
  for (const deposit of deposits) {
    const reserve = reserves.get(deposit.mint);
    const oraclePrice = prices.get(deposit.mint);
    
    if (!reserve) {
      logger.debug(
        { mint: deposit.mint, reserve: deposit.reserve },
        "Reserve not found for deposit, skipping"
      );
      scored = false;
      continue;
    }
    
    if (!oraclePrice) {
      logger.debug(
        { mint: deposit.mint, reserve: deposit.reserve },
        "Price not found for deposit, skipping"
      );
      scored = false;
      continue;
    }
    
    // Staleness guard: skip if timestamp/slot is zero
    if (Number(oraclePrice.slot) <= 0) {
      logger.debug(
        { mint: deposit.mint, slot: oraclePrice.slot.toString() },
        "Stale price (slot=0) for deposit, skipping"
      );
      scored = false;
      continue;
    }
    
    // Convert price and confidence to UI units
    const baseUi = uiFromMantissa(oraclePrice.price, oraclePrice.exponent);
    const confUi = uiFromMantissa(oraclePrice.confidence, oraclePrice.exponent);
    
    if (baseUi === null || confUi === null) {
      logger.debug(
        { mint: deposit.mint, baseUi, confUi },
        "Invalid price conversion for deposit, skipping"
      );
      continue;
    }
    
    // Apply confidence adjustment and stablecoin clamping for collateral
    const priceUi = adjustedUiPrice(deposit.mint, baseUi, confUi, "collateral");
    
    if (priceUi === null) {
      logger.debug(
        { mint: deposit.mint, baseUi, confUi },
        "Invalid adjusted price for deposit, skipping"
      );
      continue;
    }
    
    // Convert deposit notes (collateral tokens) to underlying liquidity tokens using exchange rate
    // Deposits are in cToken notes; exchange rate converts them to underlying amount
    const depositedNotesSf = BigInt(deposit.depositedAmount);
    const collateralRateBsf = reserve.collateralExchangeRateBsf;
    
    if (collateralRateBsf === 0n) {
      logger.warn(
        { mint: deposit.mint, reserve: deposit.reserve },
        "Collateral exchange rate is zero, skipping deposit"
      );
      scored = false;
      continue;
    }
    
    // Use safe bigint division to avoid precision loss
    // underlyingBaseUnits = depositedNotesSf / collateralExchangeRateBsf
    const underlyingBaseUnits = divBigintToNumber(depositedNotesSf, collateralRateBsf, 18);
    
    // Now normalize to UI using LIQUIDITY decimals (since we're now in underlying units)
    const amountUi = underlyingBaseUnits / Math.pow(10, reserve.liquidityDecimals);
    
    if (!isFinite(amountUi) || amountUi < 0) {
      logger.debug(
        { mint: deposit.mint, underlyingBaseUnits, amountUi },
        "Invalid deposit amount after exchange rate conversion, skipping"
      );
      continue;
    }
    
    // Apply liquidationThreshold weight (convert percentage to decimal)
    const weight = reserve.liquidationThreshold / 100;
    
    collateralUSD += amountUi * priceUi * weight;
    
    logger.debug(
      {
        mint: deposit.mint,
        amount: amountUi,
        price: priceUi,
        weight,
        value: amountUi * priceUi * weight,
      },
      "Processed deposit"
    );
  }
  
  // Process borrows
  for (const borrow of borrows) {
    const reserve = reserves.get(borrow.mint);
    const oraclePrice = prices.get(borrow.mint);
    
    if (!reserve) {
      logger.debug(
        { mint: borrow.mint, reserve: borrow.reserve },
        "Reserve not found for borrow, skipping"
      );
      scored = false;
      continue;
    }
    
    if (!oraclePrice) {
      logger.debug(
        { mint: borrow.mint, reserve: borrow.reserve },
        "Price not found for borrow, skipping"
      );
      scored = false;
      continue;
    }
    
    // Staleness guard: skip if timestamp/slot is zero
    if (Number(oraclePrice.slot) <= 0) {
      logger.debug(
        { mint: borrow.mint, slot: oraclePrice.slot.toString() },
        "Stale price (slot=0) for borrow, skipping"
      );
      scored = false;
      continue;
    }
    
    // Convert price and confidence to UI units
    const baseUi = uiFromMantissa(oraclePrice.price, oraclePrice.exponent);
    const confUi = uiFromMantissa(oraclePrice.confidence, oraclePrice.exponent);
    
    if (baseUi === null || confUi === null) {
      logger.debug(
        { mint: borrow.mint, baseUi, confUi },
        "Invalid price conversion for borrow, skipping"
      );
      continue;
    }
    
    // Apply confidence adjustment and stablecoin clamping for borrow
    const priceUi = adjustedUiPrice(borrow.mint, baseUi, confUi, "borrow");
    
    if (priceUi === null) {
      logger.debug(
        { mint: borrow.mint, baseUi, confUi },
        "Invalid adjusted price for borrow, skipping"
      );
      continue;
    }
    
    // Convert borrowedAmountSf (scaled fraction) to actual token amount
    // borrowedAmountSf needs to be divided by cumulativeBorrowRateBsf
    // Use safe bigint division to avoid precision loss from Number(BigInt)
    const borrowedAmountSf = BigInt(borrow.borrowedAmount);
    const cumulativeBorrowRateBsf = BigInt(reserve.cumulativeBorrowRate);
    
    if (cumulativeBorrowRateBsf === 0n) {
      logger.warn(
        { mint: borrow.mint, reserve: borrow.reserve },
        "Cumulative borrow rate is zero, skipping borrow"
      );
      continue;
    }
    
    // Convert SF to token amount using safe bigint division
    // tokenAmount = borrowedAmountSf / cumulativeBorrowRateBsf
    // This preserves precision by keeping everything in bigint until the final conversion
    const tokenAmount = divBigintToNumber(borrowedAmountSf, cumulativeBorrowRateBsf, 18);
    
    // Check for invalid result
    if (!isFinite(tokenAmount)) {
      logger.warn(
        { 
          mint: borrow.mint, 
          borrowedAmountSf: borrow.borrowedAmount,
          cumulativeBorrowRate: reserve.cumulativeBorrowRate,
          tokenAmount 
        },
        "Invalid token amount after SF conversion (not finite), skipping"
      );
      continue;
    }
    
    // Clamp tiny negative floating point artifacts to zero
    const tokenAmountClamped = tokenAmount < 0 && tokenAmount > -FLOATING_POINT_TOLERANCE ? 0 : tokenAmount;
    
    if (tokenAmountClamped < 0) {
      logger.warn(
        { 
          mint: borrow.mint, 
          tokenAmount: tokenAmountClamped 
        },
        "Negative token amount after SF conversion, skipping"
      );
      continue;
    }
    
    // Convert to UI units using liquidityDecimals (borrows are in liquidity token)
    const amountUi = tokenAmountClamped / Math.pow(10, reserve.liquidityDecimals);
    
    if (!isFinite(amountUi)) {
      logger.debug(
        { mint: borrow.mint, tokenAmount: tokenAmountClamped, amountUi },
        "Invalid borrow amount after decimal conversion, skipping"
      );
      continue;
    }
    
    // Apply borrowFactor (percentage, convert to decimal)
    // borrowFactor defaults to 100 (meaning 1.0x), so divide by 100
    const borrowFactorPct = reserve.borrowFactor ?? 100;
    const borrowFactor = borrowFactorPct / 100;
    
    borrowUSD += amountUi * priceUi * borrowFactor;
    
    logger.debug(
      {
        mint: borrow.mint,
        amount: amountUi,
        price: priceUi,
        borrowFactor,
        value: amountUi * priceUi * borrowFactor,
      },
      "Processed borrow"
    );
  }
  
  // Check for NaN/Infinity in USD values
  if (!isFinite(collateralUSD) || !isFinite(borrowUSD)) {
    scored = false;
  }
  
  // If not scored (missing components), return null healthRatio
  if (!scored) {
    return { 
      healthRatio: null, 
      borrowValue: isFinite(borrowUSD) ? borrowUSD : 0, 
      collateralValue: isFinite(collateralUSD) ? collateralUSD : 0 
    };
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
  
  // Final check to ensure no NaN sneaks through
  if (!isFinite(ratio)) {
    return { 
      healthRatio: null, 
      borrowValue: borrowUSD, 
      collateralValue: collateralUSD 
    };
  }
  
  return {
    healthRatio: ratio,
    borrowValue: borrowUSD,
    collateralValue: collateralUSD,
  };
}
