import { scoreHazard } from '../predict/hazardScorer.js';
import { computeEV, type EvParams } from '../predict/evCalculator.js';
import { estimateTtlString } from '../predict/ttlEstimator.js';
import { parseTtlMinutes } from '../predict/forecastTTLManager.js';

export interface FlashloanPlan {
  key: string;
  ownerPubkey?: string;
  mint: 'USDC' | 'SOL' | string;
  amountUi?: string; // for USDC plans only; other mints convert at dispatch
  amountUsd: number;
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
  return {
    key: c.key ?? c.obligationPubkey ?? 'unknown',
    ownerPubkey: c.ownerPubkey,
    mint,
    amountUi,
    amountUsd,
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
  
  const hazard = scoreHazard(Number(candidateLike.healthRatioRaw ?? candidateLike.healthRatio ?? 0), Number(process.env.HAZARD_ALPHA ?? 25));
  const ev = computeEV(amountUsd, hazard, evParams);
  const ttlStr = estimateTtlString(candidateLike, {
    solDropPctPerMin: Number(process.env.TTL_SOL_DROP_PCT_PER_MIN ?? 0.2),
    maxDropPct: Number(process.env.TTL_MAX_DROP_PCT ?? 20),
  });
  
  // Parse TTL string into minutes using shared utility
  const ttlMin = parseTtlMinutes(ttlStr);
  
  return {
    ...plan,
    prevEv: plan.ev,
    ev,
    hazard,
    ttlMin,
    ttlStr,
    createdAtMs: Date.now(),
    amountUi,
    amountUsd,
  };
}

