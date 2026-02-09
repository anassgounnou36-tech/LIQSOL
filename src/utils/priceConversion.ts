import { logger } from "../observability/logger.js";

/**
 * Converts oracle price mantissa and exponent to UI price (human-readable)
 * 
 * @param price - Price mantissa (bigint)
 * @param exponent - Price exponent (negative for division)
 * @returns UI price as number, or null if invalid
 */
export function uiPriceFromMantissa(price: bigint, exponent: number): number | null {
  try {
    if (!Number.isFinite(exponent)) {
      return null;
    }
    
    // UI price = mantissa × 10^exponent
    const uiPrice = Number(price) * Math.pow(10, exponent);
    
    // Guard against non-finite results (overflow, underflow, NaN)
    if (!Number.isFinite(uiPrice)) {
      return null;
    }
    
    return uiPrice;
  } catch (error) {
    logger.debug({ price: price.toString(), exponent, error }, "Failed to convert mantissa to UI price");
    return null;
  }
}
