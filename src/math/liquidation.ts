/**
 * Determines if an obligation is liquidatable based on health ratio
 * 
 * Since the health ratio is computed using liquidation-threshold-weighted collateral,
 * the obligation is liquidatable when healthRatio < 1.0 (threshold already applied in weighting).
 * 
 * @param healthRatio - Current health ratio of the obligation (threshold-weighted collateral / borrow value)
 * @param _threshold - @deprecated Threshold parameter no longer used; health ratio already includes threshold weighting
 * @returns true if health ratio is below 1.0 (liquidatable), false otherwise
 */
export function isLiquidatable(healthRatio: number, _threshold?: number): boolean {
  return healthRatio < 1.0;
}
