import { scoreHazard } from '../predict/hazardScorer.js';
import { estimatePlanEv, type PlanEvParams } from '../predict/evCalculator.js';
import { estimateTtl } from '../predict/ttlEstimator.js';
import { parseTtlMinutes } from '../predict/forecastTTLManager.js';
import type { PlanAwareEvContext } from '../predict/evContext.js';

/**
 * Compute absolute predicted liquidation timestamp from TTL minutes
 * Returns null if TTL is unknown/invalid
 */
function computePredictedLiquidationAtMs(ttlMin: number, nowMs: number): number | null {
  if (!Number.isFinite(ttlMin)) return null;
  if (ttlMin < 0) return nowMs; // Already expired
  return nowMs + Math.floor(ttlMin * 60 * 1000);
}

export interface FlashloanPlan {
  // PR2: Plan versioning and liquidation fields
  planVersion: number; // Must be 2 for PR2+ executors
  
  // Obligation and liquidation details
  key: string; // obligationPubkey
  ownerPubkey?: string;
  obligationPubkey: string; // explicit obligation pubkey for liquidation
  
  // Flashloan parameters
  mint: 'USDC' | 'SOL' | string;
  amountUi?: string; // for USDC plans only; other mints convert at dispatch
  amountUsd: number;
  
  // Liquidation parameters (PR2 required fields)
  repayMint: string; // mint pubkey of asset to repay
  repayAmountBaseUnits?: string; // repay amount in base units (if known)
  repayDecimals?: number; // decimals for repay mint
  collateralMint: string; // mint pubkey of collateral to seize
  collateralDecimals?: number; // decimals for collateral mint
  repayReservePubkey?: string; // reserve pubkey for repay asset
  collateralReservePubkey?: string; // reserve pubkey for collateral asset
  
  // Forecast and scoring
  ev: number;
  hazard: number;
  ttlMin: number | null; // null for unknown TTL
  ttlStr?: string;
  createdAtMs: number;
  ttlComputedAtMs: number;
  ttlComputedMin: number | null;
  predictedLiquidationAtMs?: number | null; // absolute epoch timestamp when liquidation predicted
  ttlModel?: string;
  ttlConfidence?: 'high' | 'medium' | 'low';
  ttlDriverMint?: string;
  ttlDriverSide?: 'deposit' | 'borrow';
  ttlRequiredMovePct?: number;
  prevEv?: number; // optional: previous EV for audit
  liquidationEligible?: boolean; // PR10+: whether obligation is currently liquidatable
  assets?: string[];
  evModel?: 'selected-leg-dynamic-bonus' | 'legacy-flat';
  evRepayCapUsd?: number;
  evGrossBonusPct?: number;
  evNetBonusPct?: number;
  evProfitUsd?: number;
  evCostUsd?: number;
  evSwapRequired?: boolean;
}

export function buildPlanFromCandidate(c: any, defaultMint: 'USDC' | 'SOL' = 'USDC'): FlashloanPlan {
  const mint = c.borrowMint ?? c.primaryBorrowMint ?? defaultMint;
  const amountUsd = Number(c.borrowValueUsd ?? 0);
  const amountUi = mint === 'USDC' ? amountUsd.toFixed(2) : undefined;
  const obligationPubkey = c.key ?? c.obligationPubkey ?? 'unknown';
  
  // PR2: Extract liquidation fields from candidate
  const repayMint = c.primaryBorrowMint ?? c.borrowMint ?? mint;
  const collateralMint = c.primaryCollateralMint ?? c.collateralMint ?? '';
  
  const nowMs = Date.now();
  // Parse TTL: use ttlMin if provided, otherwise parse from ttlStr
  const ttlString = c.forecast?.timeToLiquidation ?? c.ttlStr ?? c.ttl;
  let ttlMin: number | null;
  if (c.ttlMin !== undefined && c.ttlMin !== null) {
    const ttlMinRaw = Number(c.ttlMin);
    ttlMin = Number.isFinite(ttlMinRaw) ? ttlMinRaw : null;
  } else {
    ttlMin = parseTtlMinutes(ttlString);
  }
  const ttlComputedAtMs = nowMs;
  const ttlComputedMin = ttlMin;
  const predictedLiquidationAtMs = ttlComputedMin !== null
    ? computePredictedLiquidationAtMs(ttlComputedMin, ttlComputedAtMs)
    : null;
  
  return {
    planVersion: 2, // PR2 plan version
    key: obligationPubkey,
    obligationPubkey,
    ownerPubkey: c.ownerPubkey,
    mint,
    amountUi,
    amountUsd,
    repayMint,
    collateralMint,
    repayDecimals: c.repayDecimals,
    collateralDecimals: c.collateralDecimals,
    repayReservePubkey: c.repayReservePubkey,
    collateralReservePubkey: c.collateralReservePubkey,
    ev: Number(c.ev ?? 0),
    hazard: Number(c.hazard ?? 0),
    ttlMin,
    ttlStr: ttlString,
    createdAtMs: nowMs,
    ttlComputedAtMs,
    ttlComputedMin,
    predictedLiquidationAtMs,
    ttlModel: c.forecast?.model,
    ttlConfidence: c.forecast?.confidence,
    ttlDriverMint: c.forecast?.driverMint,
    ttlDriverSide: c.forecast?.driverSide,
    ttlRequiredMovePct: c.forecast?.requiredMovePct,
    liquidationEligible: c.liquidationEligible ?? false,
    assets: Array.isArray(c.assets) ? c.assets : undefined,
    evModel: c.evModel,
    evRepayCapUsd: c.evRepayCapUsd,
    evGrossBonusPct: c.evGrossBonusPct,
    evNetBonusPct: c.evNetBonusPct,
    evProfitUsd: c.evProfitUsd,
    evCostUsd: c.evCostUsd,
    evSwapRequired: c.evSwapRequired,
  };
}

export function recomputePlanFields(plan: FlashloanPlan, candidateLike: any): FlashloanPlan {
  if (!candidateLike) {
    return {
      ...plan,
      planVersion: plan.planVersion ?? 2,
    };
  }

  const mint = plan.mint as any;
  const amountUsd = Number(candidateLike.borrowValueUsd ?? plan.amountUsd);
  const amountUi = mint === 'USDC' ? amountUsd.toFixed(2) : plan.amountUi;
  
  const evParams: PlanEvParams = {
    closeFactor: Number(process.env.EV_CLOSE_FACTOR ?? 0.5),
    liquidationBonusPct: Number(process.env.EV_LIQUIDATION_BONUS_PCT ?? 0.05),
    flashloanFeePct: Number(process.env.EV_FLASHLOAN_FEE_PCT ?? 0.002),
    fixedGasUsd: Number(process.env.EV_FIXED_GAS_USD ?? 0.5),
    slippageBufferPct: process.env.EV_SLIPPAGE_BUFFER_PCT ? Number(process.env.EV_SLIPPAGE_BUFFER_PCT) : undefined,
    minLiquidationBonusPctFallback: Number(process.env.EV_MIN_LIQUIDATION_BONUS_PCT ?? 0.02),
    bonusFullSeverityHrGap: Number(process.env.EV_BONUS_FULLY_SEVERE_HR_GAP ?? 0.10),
    sameMintSlippageBufferPct: Number(process.env.EV_SAME_MINT_SLIPPAGE_BUFFER_PCT ?? 0),
  };
  
  // Safely compute hazard: use candidate HR if available, otherwise fallback to plan.hazard
  const hasHr = candidateLike.healthRatioRaw != null || candidateLike.healthRatio != null;
  const hazard = hasHr
    ? scoreHazard(Number(candidateLike.healthRatioRaw ?? candidateLike.healthRatio ?? 0), Number(process.env.HAZARD_ALPHA ?? 25))
    : Number(plan.hazard ?? 0);
  
  const candidateForEv = {
    borrowValueUsd: amountUsd,
    healthRatio: candidateLike.healthRatio,
    healthRatioRaw: candidateLike.healthRatioRaw,
    liquidationEligible: candidateLike.liquidationEligible,
    evContext: candidateLike.evContext as PlanAwareEvContext | undefined,
  };
  const evEstimate = estimatePlanEv(candidateForEv, hazard, evParams);
  const ev = evEstimate.ev;
  const forecastTtlString = candidateLike.forecast?.timeToLiquidation;
  const ttlEstimate = forecastTtlString
    ? null
    : estimateTtl(candidateLike, {
        volatileMovePctPerMin: Number(
          process.env.TTL_VOLATILE_MOVE_PCT_PER_MIN ?? process.env.TTL_SOL_DROP_PCT_PER_MIN ?? 0.2
        ),
        stableMovePctPerMin: Number(process.env.TTL_STABLE_MOVE_PCT_PER_MIN ?? 0.02),
        maxMovePct: Number(process.env.TTL_MAX_DROP_PCT ?? 20),
        legacySolDropPctPerMin: Number(process.env.TTL_SOL_DROP_PCT_PER_MIN ?? 0.2),
      });
  const ttlStr = forecastTtlString ?? ttlEstimate?.ttlString ?? 'unknown';
  
  // Parse TTL string into minutes using shared utility
  const ttlMin = parseTtlMinutes(ttlStr);
  
  // Compute absolute predicted liquidation timestamp
  const nowMs = Date.now();
  const ttlComputedAtMs = nowMs;
  const ttlComputedMin = ttlMin;
  const predictedLiquidationAtMs = ttlComputedMin !== null
    ? computePredictedLiquidationAtMs(ttlComputedMin, ttlComputedAtMs)
    : null;
  
  // PR2: Update liquidation fields from candidate if available
  const repayMint = candidateLike.primaryBorrowMint ?? candidateLike.borrowMint ?? plan.repayMint;
  const collateralMint = candidateLike.primaryCollateralMint ?? candidateLike.collateralMint ?? plan.collateralMint;
  
  return {
    ...plan,
    planVersion: 2, // Ensure plan version is updated
    prevEv: plan.ev,
    ev,
    hazard,
    ttlMin,
    ttlStr,
    createdAtMs: plan.createdAtMs ?? nowMs,
    ttlComputedAtMs,
    ttlComputedMin,
    predictedLiquidationAtMs,
    ttlModel: candidateLike.forecast?.model ?? ttlEstimate?.model ?? plan.ttlModel,
    ttlConfidence: candidateLike.forecast?.confidence ?? ttlEstimate?.confidence ?? plan.ttlConfidence,
    ttlDriverMint: candidateLike.forecast?.driverMint ?? ttlEstimate?.driverMint ?? plan.ttlDriverMint,
    ttlDriverSide: candidateLike.forecast?.driverSide ?? ttlEstimate?.driverSide ?? plan.ttlDriverSide,
    ttlRequiredMovePct:
      candidateLike.forecast?.requiredMovePct ?? ttlEstimate?.requiredMovePct ?? plan.ttlRequiredMovePct,
    amountUi,
    amountUsd,
    repayMint,
    collateralMint,
    repayDecimals: candidateLike.repayDecimals ?? plan.repayDecimals,
    collateralDecimals: candidateLike.collateralDecimals ?? plan.collateralDecimals,
    repayReservePubkey: candidateLike.repayReservePubkey ?? plan.repayReservePubkey,
    collateralReservePubkey: candidateLike.collateralReservePubkey ?? plan.collateralReservePubkey,
    liquidationEligible: candidateLike.liquidationEligible ?? plan.liquidationEligible ?? false,
    assets: candidateLike?.assets ?? plan.assets,
    evModel: candidateLike.evModel ?? evEstimate.breakdown.model,
    evRepayCapUsd: candidateLike.evRepayCapUsd ?? evEstimate.breakdown.repayCapUsd,
    evGrossBonusPct: candidateLike.evGrossBonusPct ?? evEstimate.breakdown.grossBonusPct,
    evNetBonusPct: candidateLike.evNetBonusPct ?? evEstimate.breakdown.netBonusPct,
    evProfitUsd: candidateLike.evProfitUsd ?? evEstimate.breakdown.profitUsd,
    evCostUsd: candidateLike.evCostUsd ?? evEstimate.breakdown.costUsd,
    evSwapRequired: candidateLike.evSwapRequired ?? evEstimate.breakdown.swapRequired,
  };
}
