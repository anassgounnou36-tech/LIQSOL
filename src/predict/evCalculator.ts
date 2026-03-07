/**
 * Expected Value (EV) Calculator Module
 * 
 * Computes the expected value of attempting a liquidation based on:
 * - Hazard score (probability of liquidation success)
 * - Position size (borrow value in USD)
 * - Liquidation parameters (close factor, bonus, fees, etc.)
 */

import type { PlanAwareEvContext } from './evContext.js';

const DEFAULT_MIN_LIQUIDATION_BONUS_PCT = 0.02;

export interface EvParams {
  closeFactor: number;             // e.g., 0.5 (50% of debt can be closed)
  liquidationBonusPct: number;     // e.g., 0.05 (5% bonus on collateral)
  flashloanFeePct: number;         // e.g., 0.002 (0.2% flashloan fee)
  fixedGasUsd: number;             // e.g., 0.5 (fixed gas cost in USD)
  slippageBufferPct?: number;      // optional e.g., 0.005 (0.5% slippage buffer)
}

export interface PlanEvParams extends EvParams {
  minLiquidationBonusPctFallback?: number;
  bonusFullSeverityHrGap?: number;
  sameMintSlippageBufferPct?: number;
}

export interface EvBreakdown {
  repayValueUsd: number;
  profit: number;
  variableFees: number;
  cost: number;
  ev: number;
}

export interface PlanEvBreakdown {
  repayCapUsd: number;
  grossBonusPct: number;
  netBonusPct: number;
  collateralProceedsUsd: number;
  profitUsd: number;
  flashloanFeeUsd: number;
  slippageUsd: number;
  fixedGasUsd: number;
  costUsd: number;
  swapRequired: boolean;
  model: 'selected-leg-dynamic-bonus' | 'legacy-flat';
}

export interface PlanEvEstimate {
  ev: number;
  breakdown: PlanEvBreakdown;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
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

/**
 * Compute EV and its intermediate values for diagnostics and debugging.
 *
 * @param borrowValueUsd - Total borrow value in USD
 * @param hazard - Hazard score from hazardScorer (0 to 1)
 * @param p - EV parameters (fees, bonuses, etc.)
 * @returns EV breakdown including repay value, profit, variable fees, total cost, and final EV
 */
export function computeEVBreakdown(borrowValueUsd: number, hazard: number, p: EvParams): EvBreakdown {
  const repayValueUsd = p.closeFactor * borrowValueUsd;
  const profit = p.liquidationBonusPct * repayValueUsd;
  const variableFees = (p.flashloanFeePct + (p.slippageBufferPct ?? 0)) * repayValueUsd;
  const cost = variableFees + p.fixedGasUsd;
  const ev = (hazard * profit) - cost;
  return { repayValueUsd, profit, variableFees, cost, ev };
}

function toLegacyPlanBreakdown(legacy: EvBreakdown, borrowValueUsd: number, p: PlanEvParams): PlanEvBreakdown {
  const repayCapUsd = p.closeFactor * borrowValueUsd;
  const flashloanFeeUsd = p.flashloanFeePct * repayCapUsd;
  const slippageUsd = (p.slippageBufferPct ?? 0) * repayCapUsd;
  return {
    repayCapUsd,
    grossBonusPct: p.liquidationBonusPct,
    netBonusPct: p.liquidationBonusPct,
    collateralProceedsUsd: legacy.repayValueUsd + legacy.profit,
    profitUsd: legacy.profit,
    flashloanFeeUsd,
    slippageUsd,
    fixedGasUsd: p.fixedGasUsd,
    costUsd: legacy.cost,
    swapRequired: false,
    model: 'legacy-flat',
  };
}

function hasValidPlanContext(evContext?: PlanAwareEvContext): evContext is PlanAwareEvContext {
  return !!evContext &&
    Number.isFinite(evContext.selectedBorrowUsdRaw) &&
    Number.isFinite(evContext.selectedCollateralUsdRaw) &&
    Number.isFinite(evContext.totalBorrowUsdRaw);
}

export function estimatePlanEv(
  candidate: {
    borrowValueUsd: number;
    healthRatio?: number;
    healthRatioRaw?: number;
    liquidationEligible?: boolean;
    evContext?: PlanAwareEvContext;
  },
  hazard: number,
  p: PlanEvParams
): PlanEvEstimate {
  if (hasValidPlanContext(candidate.evContext)) {
    const evContext = candidate.evContext;
    const repayCapUsd = Math.min(
      evContext.selectedBorrowUsdRaw,
      evContext.totalBorrowUsdRaw * p.closeFactor
    );

    if (repayCapUsd > 0) {
      const minBonusPct =
        evContext.minLiquidationBonusPct ??
        p.minLiquidationBonusPctFallback ??
        DEFAULT_MIN_LIQUIDATION_BONUS_PCT;
      const maxBonusPct = evContext.maxLiquidationBonusPct ?? p.liquidationBonusPct;
      const hr = Number(candidate.healthRatioRaw ?? candidate.healthRatio ?? 0);
      const bonusFullSeverityHrGap = p.bonusFullSeverityHrGap ?? 0.10;
      const grossBonusPct = hr >= 1
        ? minBonusPct
        : minBonusPct + (maxBonusPct - minBonusPct) * clamp((1 - hr) / bonusFullSeverityHrGap, 0, 1);
      const netBonusPct = grossBonusPct * (1 - (evContext.protocolLiquidationFeePct ?? 0));
      const collateralProceedsUsd = Math.min(
        evContext.selectedCollateralUsdRaw,
        repayCapUsd * (1 + netBonusPct)
      );
      const profitUsd = Math.max(0, collateralProceedsUsd - repayCapUsd);
      const flashloanFeeUsd = p.flashloanFeePct * repayCapUsd;
      const slippageBufferPct = evContext.swapRequired
        ? (p.slippageBufferPct ?? 0)
        : (p.sameMintSlippageBufferPct ?? 0);
      const slippageUsd = slippageBufferPct * repayCapUsd;
      const costUsd = flashloanFeeUsd + slippageUsd + p.fixedGasUsd;
      const ev = (hazard * profitUsd) - costUsd;

      return {
        ev,
        breakdown: {
          repayCapUsd,
          grossBonusPct,
          netBonusPct,
          collateralProceedsUsd,
          profitUsd,
          flashloanFeeUsd,
          slippageUsd,
          fixedGasUsd: p.fixedGasUsd,
          costUsd,
          swapRequired: evContext.swapRequired,
          model: 'selected-leg-dynamic-bonus',
        },
      };
    }
  }

  const legacy = computeEVBreakdown(candidate.borrowValueUsd, hazard, p);
  return {
    ev: legacy.ev,
    breakdown: toLegacyPlanBreakdown(legacy, candidate.borrowValueUsd, p),
  };
}
