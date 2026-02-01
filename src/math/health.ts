import { logger } from "../observability/logger.js";
import type { ReserveCacheEntry } from "../cache/reserveCache.js";
import type { OraclePriceData } from "../cache/oracleCache.js";
import type { ObligationDeposit, ObligationBorrow } from "../kamino/types.js";

/**
 * Known stablecoin mints for price clamping
 */
const STABLECOIN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
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
 * Result of health ratio computation
 */
export interface HealthRatioResult {
  /** Health ratio (collateralValueWeighted / borrowValue), clamped to [0, 2] */
  healthRatio: number;
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
 */
function uiFromMantissa(price: bigint, exponent: number): number {
  return Number(price) * Math.pow(10, exponent);
}

/**
 * Apply confidence adjustment and stablecoin clamping
 * 
 * @param mint - Token mint address
 * @param basePrice - Base price in UI units
 * @param confidence - Confidence in UI units
 * @param side - Whether this is for collateral or borrow valuation
 * @returns Adjusted price
 */
function adjustedUiPrice(
  mint: string,
  basePrice: number,
  confidence: number,
  side: "collateral" | "borrow"
): number {
  // Apply confidence adjustment
  const adjustedPrice = side === "collateral" 
    ? Math.max(0, basePrice - confidence)
    : basePrice + confidence;
  
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
  
  // Process deposits (collateral)
  for (const deposit of deposits) {
    const reserve = reserves.get(deposit.mint);
    const oraclePrice = prices.get(deposit.mint);
    
    if (!reserve) {
      logger.debug(
        { mint: deposit.mint, reserve: deposit.reserve },
        "Reserve not found for deposit, skipping"
      );
      continue;
    }
    
    if (!oraclePrice) {
      logger.debug(
        { mint: deposit.mint, reserve: deposit.reserve },
        "Price not found for deposit, skipping"
      );
      continue;
    }
    
    // Staleness guard: skip if timestamp/slot is zero
    if (Number(oraclePrice.slot) <= 0) {
      logger.debug(
        { mint: deposit.mint, slot: oraclePrice.slot.toString() },
        "Stale price (slot=0) for deposit, skipping"
      );
      continue;
    }
    
    // Convert price and confidence to UI units
    const baseUi = uiFromMantissa(oraclePrice.price, oraclePrice.exponent);
    const confUi = uiFromMantissa(oraclePrice.confidence, oraclePrice.exponent);
    
    // Apply confidence adjustment and stablecoin clamping for collateral
    const priceUi = adjustedUiPrice(deposit.mint, baseUi, confUi, "collateral");
    
    // Convert amount to UI units
    const amountUi = Number(BigInt(deposit.depositedAmount)) / Math.pow(10, reserve.liquidityDecimals);
    
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
      continue;
    }
    
    if (!oraclePrice) {
      logger.debug(
        { mint: borrow.mint, reserve: borrow.reserve },
        "Price not found for borrow, skipping"
      );
      continue;
    }
    
    // Staleness guard: skip if timestamp/slot is zero
    if (Number(oraclePrice.slot) <= 0) {
      logger.debug(
        { mint: borrow.mint, slot: oraclePrice.slot.toString() },
        "Stale price (slot=0) for borrow, skipping"
      );
      continue;
    }
    
    // Convert price and confidence to UI units
    const baseUi = uiFromMantissa(oraclePrice.price, oraclePrice.exponent);
    const confUi = uiFromMantissa(oraclePrice.confidence, oraclePrice.exponent);
    
    // Apply confidence adjustment and stablecoin clamping for borrow
    const priceUi = adjustedUiPrice(borrow.mint, baseUi, confUi, "borrow");
    
    // Convert amount to UI units
    const amountUi = Number(BigInt(borrow.borrowedAmount)) / Math.pow(10, reserve.liquidityDecimals);
    
    // Apply borrowFactor (should be in reserve, default to 1.0)
    const borrowFactor = (reserve as any).borrowFactor ?? 1.0;
    
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
  
  return {
    healthRatio: ratio,
    borrowValue: borrowUSD,
    collateralValue: collateralUSD,
  };
}
