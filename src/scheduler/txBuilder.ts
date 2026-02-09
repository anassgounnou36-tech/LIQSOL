import { scoreHazard } from '../predict/hazardScorer.js';
import { computeEV, type EvParams } from '../predict/evCalculator.js';
import { estimateTtlString } from '../predict/ttlEstimator.js';
import { parseTtlMinutes } from '../predict/forecastTTLManager.js';

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
  ttlMin: number;
  ttlStr?: string;
  createdAtMs: number;
  prevEv?: number; // optional: previous EV for audit
}

export function buildPlanFromCandidate(c: any, defaultMint: 'USDC' | 'SOL' = 'USDC'): FlashloanPlan {
  const mint = c.borrowMint ?? c.primaryBorrowMint ?? defaultMint;
  const amountUsd = Number(c.borrowValueUsd ?? 0);
  const amountUi = mint === 'USDC' ? amountUsd.toFixed(2) : undefined;
  const obligationPubkey = c.key ?? c.obligationPubkey ?? 'unknown';
  
  // PR2: Extract liquidation fields from candidate
  const repayMint = c.primaryBorrowMint ?? c.borrowMint ?? mint;
  const collateralMint = c.primaryCollateralMint ?? c.collateralMint ?? '';
  
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
    ttlMin: Number(c.ttlMin ?? Infinity),
    ttlStr: c.ttlStr ?? c.ttl,
    createdAtMs: Date.now(),
  };
}

export function recomputePlanFields(plan: FlashloanPlan, candidateLike: any): FlashloanPlan {
  const mint = plan.mint as any;
  const amountUsd = Number(candidateLike.borrowValueUsd ?? plan.amountUsd);
  const amountUi = mint === 'USDC' ? amountUsd.toFixed(2) : plan.amountUi;
  
  const evParams: EvParams = {
    closeFactor: Number(process.env.EV_CLOSE_FACTOR ?? 0.5),
    liquidationBonusPct: Number(process.env.EV_LIQUIDATION_BONUS_PCT ?? 0.05),
    flashloanFeePct: Number(process.env.EV_FLASHLOAN_FEE_PCT ?? 0.002),
    fixedGasUsd: Number(process.env.EV_FIXED_GAS_USD ?? 0.5),
    slippageBufferPct: process.env.EV_SLIPPAGE_BUFFER_PCT ? Number(process.env.EV_SLIPPAGE_BUFFER_PCT) : undefined,
  };
  
  // Safely compute hazard: use candidate HR if available, otherwise fallback to plan.hazard
  const hasHr = candidateLike.healthRatioRaw != null || candidateLike.healthRatio != null;
  const hazard = hasHr
    ? scoreHazard(Number(candidateLike.healthRatioRaw ?? candidateLike.healthRatio ?? 0), Number(process.env.HAZARD_ALPHA ?? 25))
    : Number(plan.hazard ?? 0);
  
  const ev = computeEV(amountUsd, hazard, evParams);
  const ttlStr = estimateTtlString(candidateLike, {
    solDropPctPerMin: Number(process.env.TTL_SOL_DROP_PCT_PER_MIN ?? 0.2),
    maxDropPct: Number(process.env.TTL_MAX_DROP_PCT ?? 20),
  });
  
  // Parse TTL string into minutes using shared utility
  const ttlMin = parseTtlMinutes(ttlStr);
  
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
    createdAtMs: Date.now(),
    amountUi,
    amountUsd,
    repayMint,
    collateralMint,
    repayDecimals: candidateLike.repayDecimals ?? plan.repayDecimals,
    collateralDecimals: candidateLike.collateralDecimals ?? plan.collateralDecimals,
    repayReservePubkey: candidateLike.repayReservePubkey ?? plan.repayReservePubkey,
    collateralReservePubkey: candidateLike.collateralReservePubkey ?? plan.collateralReservePubkey,
  };
}

