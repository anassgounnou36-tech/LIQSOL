/**
 * Hazard Scorer Module
 * 
 * Provides smooth hazard scoring based on health ratio margin.
 * The hazard score represents the probability/risk of liquidation.
 */

/**
 * Calculate a smooth hazard score based on health ratio.
 * 
 * @param healthRatio - The health ratio of the position (e.g., 0.95 = liquidatable, 1.05 = safe)
 * @param alpha - Smoothing parameter (default: 25). Higher values = steeper transition.
 * @returns Hazard score between 0 and 1, where 1 = highest risk
 */
export function scoreHazard(healthRatio: number, alpha = 25): number {
  const margin = Math.max(0, healthRatio - 1.0);
  return 1 / (1 + alpha * margin);
}
