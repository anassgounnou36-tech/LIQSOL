/**
 * PR62: Utility for exact string→integer conversion (no float math)
 * Used for converting UI amounts to base units for transactions
 */

/**
 * Parse UI amount string to base units with exact string→integer conversion.
 * No parseFloat/Math.round to avoid rounding errors.
 * 
 * @param amountUi - Amount in UI units as a string (e.g., "100.50")
 * @param decimals - Number of decimals for the mint
 * @returns Amount in base units as bigint
 * 
 * @example
 * parseUiAmountToBaseUnits("100.50", 6) // returns 100500000n (USDC)
 * parseUiAmountToBaseUnits("1.5", 9) // returns 1500000000n (SOL)
 * parseUiAmountToBaseUnits("100", 6) // returns 100000000n (USDC)
 */
export function parseUiAmountToBaseUnits(amountUi: string, decimals: number): bigint {
  // Split into integer and fractional parts
  const parts = amountUi.split('.');
  const integerPart = parts[0] || '0';
  const fractionalPart = parts[1] || '';
  
  // Pad or truncate fractional part to match decimals
  const paddedFractional = fractionalPart.padEnd(decimals, '0').slice(0, decimals);
  
  // Combine into a single integer string
  const baseUnitsStr = integerPart + paddedFractional;
  
  // Strip leading zeros (but keep at least one digit)
  const trimmed = baseUnitsStr.replace(/^0+/, '') || '0';
  
  // Convert to bigint (handles large numbers correctly)
  return BigInt(trimmed);
}
