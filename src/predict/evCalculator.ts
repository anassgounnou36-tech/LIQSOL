/**
 * Expected Value (EV) Calculator Module
 * 
 * Computes the expected value of attempting a liquidation based on:
 * - Hazard score (probability of liquidation success)
 * - Position size (borrow value in USD)
 * - Liquidation parameters (close factor, bonus, fees, etc.)
 */

export interface EvParams {
  closeFactor: number;             // e.g., 0.5 (50% of debt can be closed)
  liquidationBonusPct: number;     // e.g., 0.05 (5% bonus on collateral)
  flashloanFeePct: number;         // e.g., 0.002 (0.2% flashloan fee)
  fixedGasUsd: number;             // e.g., 0.5 (fixed gas cost in USD)
  slippageBufferPct?: number;      // optional e.g., 0.005 (0.5% slippage buffer)
}

export interface EvBreakdown {
  repayValueUsd: number;
  profit: number;
  variableFees: number;
  cost: number;
  ev: number;
}

/**
 * Compute the expected value (EV) of a liquidation attempt.
 * 
 * EV = (hazard * profit) - cost
 * 
 * Where:
 * - repayValueUsd = closeFactor * borrowValueUsd
 * - profit = liquidationBonusPct * repayValueUsd
 * - cost = variableFees + fixedGasUsd
 * - variableFees = (flashloanFeePct + slippageBufferPct) * repayValueUsd
 * 
 * @param borrowValueUsd - Total borrow value in USD
 * @param hazard - Hazard score from hazardScorer (0 to 1)
 * @param p - EV parameters (fees, bonuses, etc.)
 * @returns Expected value in USD (can be negative)
 */
export function computeEV(borrowValueUsd: number, hazard: number, p: EvParams): number {
  return computeEVBreakdown(borrowValueUsd, hazard, p).ev;
}

export function computeEVBreakdown(borrowValueUsd: number, hazard: number, p: EvParams): EvBreakdown {
  const repayValueUsd = p.closeFactor * borrowValueUsd;
  const profit = p.liquidationBonusPct * repayValueUsd;
  const variableFees = (p.flashloanFeePct + (p.slippageBufferPct ?? 0)) * repayValueUsd;
  const cost = variableFees + p.fixedGasUsd;
  const ev = (hazard * profit) - cost;
  return { repayValueUsd, profit, variableFees, cost, ev };
}
