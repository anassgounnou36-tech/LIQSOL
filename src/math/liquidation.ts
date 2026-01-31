/**
 * Determines if an obligation is liquidatable based on health ratio and threshold
 * 
 * @param healthRatio - Current health ratio of the obligation (collateral / borrow value)
 * @param threshold - Liquidation threshold (typically from reserve's liquidationThreshold)
 * @returns true if health ratio is below threshold (liquidatable), false otherwise
 */
export function isLiquidatable(healthRatio: number, threshold: number): boolean {
  return healthRatio < threshold;
}
