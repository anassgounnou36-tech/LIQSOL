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
 * Options for health ratio computation
 */
export interface HealthRatioOptions {
  /** Include detailed per-leg breakdown in result */
  includeBreakdown?: boolean;
  /** Expose raw unclamped health ratio alongside clamped value */
  exposeRawHr?: boolean;
}

/**
 * Input for health ratio computation
 */
export interface HealthRatioInput {
  /** Array of deposited collateral positions */
  deposits: ObligationDeposit[];
  /** Array of borrowed positions */
  borrows: ObligationBorrow[];
  /** Reserve cache with dual-index structure */
  reserves: Map<string, ReserveCacheEntry>;
  /** Oracle price cache keyed by mint */
  prices: Map<string, OraclePriceData>;
  /** Optional configuration for computation */
  options?: HealthRatioOptions;
}

/**
 * Detailed deposit leg breakdown for health computation
 */
export interface HealthLegDeposit {
  /** Reserve public key */
  reservePubkey: string;
  /** Collateral mint (cToken) */
  collateralMint: string;
  /** Underlying liquidity mint */
  liquidityMint: string;
  /** Collateral shares in UI units */
  collateralSharesUi: number;
  /** Underlying liquidity tokens in UI units (after exchange rate conversion) */
  underlyingUi: number;
  /** Price of underlying liquidity mint in USD */
  priceUsd: number;
  /** Raw USD value (underlyingUi * priceUsd) */
  usdRaw: number;
  /** Weighted USD value (after liquidation threshold multiplier) */
  usdWeighted: number;
}

/**
 * Detailed borrow leg breakdown for health computation
 */
export interface HealthLegBorrow {
  /** Reserve public key */
  reservePubkey: string;
  /** Liquidity mint */
  liquidityMint: string;
  /** Borrowed amount in UI units */
  borrowUi: number;
  /** Price of liquidity mint in USD */
  priceUsd: number;
  /** Raw USD value (borrowUi * priceUsd) */
  usdRaw: number;
  /** Weighted USD value (after borrow factor multiplier) */
  usdWeighted: number;
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
      /** Raw unclamped health ratio (for debugging) */
      healthRatioRaw?: number;
      /** Total borrow value in USD */
      borrowValue: number;
      /** Total collateral value in USD (weighted by liquidationThreshold) */
      collateralValue: number;
      /** Total borrow value in USD (unweighted) */
      totalBorrowUsd: number;
      /** Total collateral value in USD (unweighted) */
      totalCollateralUsd: number;
      /** Total borrow value in USD (raw / unweighted) */
      totalBorrowUsdRaw: number;
      /** Total collateral value in USD (raw / unweighted) */
      totalCollateralUsdRaw: number;
      /** Total borrow value in USD (weighted by borrow factor) */
      totalBorrowUsdAdj: number;
      /** Total collateral value in USD (weighted by liquidation threshold) */
      totalCollateralUsdAdj: number;
      /** Detailed per-leg breakdown (optional) */
      breakdown?: {
        deposits: HealthLegDeposit[];
        borrows: HealthLegBorrow[];
      };
    }
  | {
      /** Obligation could not be scored */
      scored: false;
      /** Reason why the obligation was not scored */
      reason: "MISSING_RESERVE" | "MISSING_ORACLE_PRICE" | "MISSING_EXCHANGE_RATE" | "MISSING_DEBT_RATE" | "INVALID_MATH" | "OTHER_MARKET";
    };

/**
 * Check if a mint is a known stablecoin
 */
function isStableMint(mint: string): boolean {
  return STABLECOIN_MINTS.has(mint);
}

/**
 * Convert collateral exchange rate from UI number directly
 * Returns null if missing, zero, or invalid
 */
function exchangeRateUiFromReserve(reserve: ReserveCacheEntry): number | null {
  const rate = reserve.collateralExchangeRateUi;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Convert borrowedAmountSf (scaled fraction) to UI units using bigint-safe math.
 *
 * borrowedAmountSf already includes accrued interest and is stored as:
 *   borrowedAmountSfRaw = borrowRaw * WAD
 *
 * Returns 0 for invalid/missing values.
 */
function convertBorrowSfToUi(
  borrowedAmountSf: string | undefined | null,
  liquidityDecimals: number
): number {
  if (!borrowedAmountSf) return 0;

  try {
    const borrowedSf = BigInt(borrowedAmountSf);
    if (borrowedSf < 0n) return 0;

    const WAD = 10n ** 18n;
    const borrowedTokensRaw = borrowedSf / WAD;

    // Normalize by liquidity decimals to get UI units
    const liquidityScale = 10n ** BigInt(liquidityDecimals);
    const borrowedUi = divBigintToNumber(borrowedTokensRaw, liquidityScale, liquidityDecimals);

    return Number.isFinite(borrowedUi) && borrowedUi >= 0 ? borrowedUi : 0;
  } catch {
    return 0;
  }
}

/**
 * Memoized powers of 10 for common exponents
 */
const pow10Cache = new Map<number, bigint>();

/**
 * Compute 10^n as a bigint with memoization for performance
 */
function pow10n(exp: number): bigint {
  const cached = pow10Cache.get(exp);
  if (cached !== undefined) return cached;
  
  const result = 10n ** BigInt(exp);
  pow10Cache.set(exp, result);
  return result;
}

/**
 * Convert mantissa to UI price using exponent with bigint-safe arithmetic
 * Returns null if result is NaN or Infinity
 * 
 * Uses bigint arithmetic until final conversion to avoid Number(bigint) overflow
 */
function uiFromMantissaSafe(mantissa: bigint, exponent: number): number | null {
  if (mantissa === 0n) return 0;
  
  try {
    if (exponent < 0) {
      // Divide by 10^(-exponent)
      const denom = pow10n(-exponent);
      const v = divBigintToNumber(mantissa, denom, 18);
      return Number.isFinite(v) ? v : null;
    } else {
      // Multiply by 10^exponent
      const scaled = mantissa * pow10n(exponent);
      const v = divBigintToNumber(scaled, 1n, 18);
      return Number.isFinite(v) ? v : null;
    }
  } catch {
    return null;
  }
}

/**
 * Apply confidence adjustment and stablecoin sanity check
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
  
  // Sanity check for stablecoins: reject absurd base prices outside [0.5, 2.0]
  // This catches oracle failures before applying confidence adjustments
  if (isStableMint(mint)) {
    if (basePrice < 0.5 || basePrice > 2.0) {
      logger.warn(
        { mint, basePrice },
        "Stablecoin price outside sanity bounds [0.5, 2.0], rejecting"
      );
      return null;
    }
  }
  
  // Apply confidence adjustment
  const adjustedPrice = side === "collateral" 
    ? Math.max(0, basePrice - confidence)
    : basePrice + confidence;
  
  // Check for invalid result
  if (!isFinite(adjustedPrice)) {
    return null;
  }
  
  // Apply stablecoin clamp [0.99, 1.01] to adjusted price
  if (isStableMint(mint)) {
    return Math.min(1.01, Math.max(0.99, adjustedPrice));
  }
  
  return adjustedPrice;
}

/**
 * Computes health ratio and position values for a Kamino obligation
 * 
 * Returns a discriminated union:
 * - { scored: true, healthRatio, borrowValue, collateralValue, ... } on success
 * - { scored: false, reason } when data is missing or invalid
 * 
 * This prevents treating missing data as "$0 collateral" and enables
 * proper aggregation of unscored reasons without per-deposit spam logs.
 * 
 * @param input - Health ratio computation input
 * @returns Health ratio result or unscored with reason
 */
export function computeHealthRatio(input: HealthRatioInput): HealthRatioResult {
  const { deposits, borrows, reserves, prices, options } = input;
  
  const includeBreakdown = options?.includeBreakdown ?? false;
  const exposeRawHr = options?.exposeRawHr ?? false;
  
  let collateralUSD = 0;
  let collateralUSDRaw = 0;
  let borrowUSD = 0;
  let borrowUSDRaw = 0;
  
  const depositLegs: HealthLegDeposit[] = [];
  const borrowLegs: HealthLegBorrow[] = [];
  
  // Process deposits (collateral)
  for (const deposit of deposits) {
    const reserve = reserves.get(deposit.mint);
    if (!reserve) {
      return { scored: false, reason: "MISSING_RESERVE" };
    }
    
    // Price deposits using the underlying liquidity mint, not the collateral mint (cToken)
    // Collateral tokens are shares; the oracle represents the underlying asset
    const priceMint = reserve.liquidityMint;
    
    const oraclePrice = prices.get(priceMint);
    if (!oraclePrice) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Staleness guard: skip if timestamp/slot is zero
    if (Number(oraclePrice.slot) <= 0) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Convert price and confidence to UI units
    const baseUi = uiFromMantissaSafe(oraclePrice.price, oraclePrice.exponent);
    const confUi = uiFromMantissaSafe(oraclePrice.confidence, oraclePrice.exponent);
    
    if (baseUi === null || confUi === null) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Apply confidence adjustment and stablecoin clamping for collateral
    const priceUi = adjustedUiPrice(priceMint, baseUi, confUi, "collateral");
    
    if (priceUi === null || priceUi <= 0) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Parse exchange rate: if missing or zero, mark unscored (not $0 collateral)
    const exchangeRateUi = exchangeRateUiFromReserve(reserve);
    
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
    // With the corrected exchange rate formula (collateralSupply / totalLiquidity),
    // we divide depositedNotesUi by exchangeRateUi to get underlying liquidity
    // This is equivalent to: (depositedNotesUi * totalLiquidityUi) / collateralSupplyUi
    const depositUi = depositedNotesUi / exchangeRateUi;
    
    // Calculate raw USD value (unweighted)
    const valueUSDRaw = depositUi * priceUi;
    
    // Apply liquidation threshold weight
    const weight = reserve.liquidationThreshold / 100;
    const valueUSD = valueUSDRaw * weight;
    
    if (!Number.isFinite(valueUSD) || !Number.isFinite(valueUSDRaw)) {
      return { scored: false, reason: "INVALID_MATH" };
    }
    
    collateralUSD += Math.max(0, valueUSD);
    collateralUSDRaw += Math.max(0, valueUSDRaw);
    
    // Collect breakdown if requested
    if (includeBreakdown) {
      depositLegs.push({
        reservePubkey: deposit.reserve,
        collateralMint: deposit.mint,
        liquidityMint: priceMint,
        collateralSharesUi: depositedNotesUi,
        underlyingUi: depositUi,
        priceUsd: priceUi,
        usdRaw: valueUSDRaw,
        usdWeighted: valueUSD,
      });
    }
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
    const baseUi = uiFromMantissaSafe(oraclePrice.price, oraclePrice.exponent);
    const confUi = uiFromMantissaSafe(oraclePrice.confidence, oraclePrice.exponent);
    
    if (baseUi === null || confUi === null) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Apply confidence adjustment and stablecoin clamping for borrow
    const priceUi = adjustedUiPrice(borrow.mint, baseUi, confUi, "borrow");
    
    if (priceUi === null || priceUi <= 0) {
      return { scored: false, reason: "MISSING_ORACLE_PRICE" };
    }
    
    // Convert SF to UI units using safe helper
    const borrowUi = convertBorrowSfToUi(
      borrow.borrowedAmount,
      reserve.liquidityDecimals
    );
    
    if (!Number.isFinite(borrowUi)) {
      return { scored: false, reason: "INVALID_MATH" };
    }
    
    // Calculate raw USD value (unweighted)
    const valueUSDRaw = borrowUi * priceUi;
    
    // Apply borrow factor (defaults to 100 = 1.0x)
    const borrowFactor = (reserve.borrowFactor ?? 100) / 100;
    const valueUSD = valueUSDRaw * borrowFactor;
    
    if (!Number.isFinite(valueUSD) || !Number.isFinite(valueUSDRaw)) {
      return { scored: false, reason: "INVALID_MATH" };
    }
    
    borrowUSD += Math.max(0, valueUSD);
    borrowUSDRaw += Math.max(0, valueUSDRaw);
    
    // Collect breakdown if requested
    if (includeBreakdown) {
      borrowLegs.push({
        reservePubkey: borrow.reserve,
        liquidityMint: borrow.mint,
        borrowUi,
        priceUsd: priceUi,
        usdRaw: valueUSDRaw,
        usdWeighted: valueUSD,
      });
    }
  }
  
  // Calculate health ratio
  let ratioRaw: number;
  if (borrowUSD <= 0 && collateralUSD <= 0) {
    // Empty position
    ratioRaw = 2.0;
  } else if (borrowUSD <= 0) {
    // No debt, maximum health
    ratioRaw = 2.0;
  } else if (collateralUSD <= 0) {
    // No collateral, unhealthy
    ratioRaw = 0.0;
  } else {
    // Normal calculation
    ratioRaw = collateralUSD / borrowUSD;
  }
  
  // Clamp to [0, 2] for ranking
  const ratio = Math.max(0, Math.min(2, ratioRaw));
  
  // Final sanity check
  if (!Number.isFinite(ratio)) {
    return { scored: false, reason: "INVALID_MATH" };
  }
  
  const result: Extract<HealthRatioResult, { scored: true }> = {
    scored: true,
    healthRatio: ratio,
    borrowValue: borrowUSD,
    collateralValue: collateralUSD,
    totalBorrowUsd: borrowUSDRaw,
    totalCollateralUsd: collateralUSDRaw,
    totalBorrowUsdRaw: borrowUSDRaw,
    totalCollateralUsdRaw: collateralUSDRaw,
    totalBorrowUsdAdj: borrowUSD,
    totalCollateralUsdAdj: collateralUSD,
  };
  
  if (exposeRawHr) {
    result.healthRatioRaw = ratioRaw;
  }
  
  if (includeBreakdown) {
    result.breakdown = {
      deposits: depositLegs,
      borrows: borrowLegs,
    };
  }
  
  return result;
}
