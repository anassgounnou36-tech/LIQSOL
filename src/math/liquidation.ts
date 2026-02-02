/**
 * Determines if an obligation is liquidatable based on health ratio
 * 
 * Since the health ratio is computed using liquidation-threshold-weighted collateral,
 * the obligation is liquidatable when healthRatio < 1.0 (threshold already applied in weighting).
 * 
 * Only scored obligations (non-null healthRatio) can be liquidatable.
 * 
 * @param healthRatio - Current health ratio of the obligation (threshold-weighted collateral / borrow value), or null if unscored
 * @returns true if health ratio is below 1.0 (liquidatable), false otherwise
 */
export function isLiquidatable(healthRatio: number | null): boolean {
  // Only scored obligations can be liquidatable
  return typeof healthRatio === "number" && healthRatio < 1.0;
}
