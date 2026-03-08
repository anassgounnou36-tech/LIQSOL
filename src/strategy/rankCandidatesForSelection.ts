import { PublicKey } from '@solana/web3.js';
import type { ReadonlyEnv } from '../config/env.js';
import {
  selectCandidates,
  type Candidate,
  type CandidateSelectorConfig,
  type ScoredObligation,
} from './candidateSelector.js';
import { applyKlendSdkVerificationToCandidates } from '../engine/applyKlendSdkVerification.js';

type RankingEnv = Pick<
  ReadonlyEnv,
  | 'USE_EV_RANKING'
  | 'MIN_BORROW_USD'
  | 'HAZARD_ALPHA'
  | 'FORECAST_TTL_MS'
  | 'TTL_VOLATILE_MOVE_PCT_PER_MIN'
  | 'TTL_STABLE_MOVE_PCT_PER_MIN'
  | 'TTL_SOL_DROP_PCT_PER_MIN'
  | 'TTL_MAX_DROP_PCT'
  | 'EV_CLOSE_FACTOR'
  | 'EV_LIQUIDATION_BONUS_PCT'
  | 'EV_MIN_LIQUIDATION_BONUS_PCT'
  | 'EV_BONUS_FULLY_SEVERE_HR_GAP'
  | 'EV_FLASHLOAN_FEE_PCT'
  | 'EV_FIXED_GAS_USD'
  | 'EV_SLIPPAGE_BUFFER_PCT'
  | 'EV_SAME_MINT_SLIPPAGE_BUFFER_PCT'
>;

type VerificationEnv = Pick<
  ReadonlyEnv,
  | 'LIQSOL_RECOMPUTED_VERIFY_BACKEND'
  | 'LIQSOL_RECOMPUTED_VERIFY_TOP_K'
  | 'LIQSOL_RECOMPUTED_VERIFY_CONCURRENCY'
  | 'LIQSOL_RECOMPUTED_VERIFY_TTL_MS'
  | 'LIQSOL_HEALTH_SOURCE'
>;

export function buildCandidateSelectorConfigFromEnv(
  env: RankingEnv,
  nearThreshold: number
): CandidateSelectorConfig {
  const slippageBuffer = Number(env.EV_SLIPPAGE_BUFFER_PCT);
  const sameMintSlippageBuffer = Number(env.EV_SAME_MINT_SLIPPAGE_BUFFER_PCT);
  return {
    nearThreshold,
    useEvRanking: env.USE_EV_RANKING === 'true',
    minBorrowUsd: Number(env.MIN_BORROW_USD),
    hazardAlpha: Number(env.HAZARD_ALPHA),
    forecastTtlMs: Number(env.FORECAST_TTL_MS),
    ttlVolatileMovePctPerMin: Number(
      env.TTL_VOLATILE_MOVE_PCT_PER_MIN ?? env.TTL_SOL_DROP_PCT_PER_MIN ?? '0.2'
    ),
    ttlStableMovePctPerMin: Number(env.TTL_STABLE_MOVE_PCT_PER_MIN ?? '0.02'),
    ttlMaxMovePct: Number(env.TTL_MAX_DROP_PCT),
    legacySolDropPctPerMin: Number(env.TTL_SOL_DROP_PCT_PER_MIN ?? '0.2'),
    evParams: {
      closeFactor: Number(env.EV_CLOSE_FACTOR),
      liquidationBonusPct: Number(env.EV_LIQUIDATION_BONUS_PCT),
      flashloanFeePct: Number(env.EV_FLASHLOAN_FEE_PCT),
      fixedGasUsd: Number(env.EV_FIXED_GAS_USD),
      slippageBufferPct: Number.isFinite(slippageBuffer) ? slippageBuffer : undefined,
      minLiquidationBonusPctFallback: Number(env.EV_MIN_LIQUIDATION_BONUS_PCT),
      bonusFullSeverityHrGap: Number(env.EV_BONUS_FULLY_SEVERE_HR_GAP),
      sameMintSlippageBufferPct: Number.isFinite(sameMintSlippageBuffer)
        ? sameMintSlippageBuffer
        : undefined,
    },
  };
}

export async function rankCandidatesWithBoundedKlendVerification(args: {
  scoredCandidates: ScoredObligation[];
  nearThreshold: number;
  topN: number;
  env: RankingEnv & VerificationEnv;
  marketPubkey: PublicKey;
  programId: PublicKey;
  rpcUrl: string;
}): Promise<{ rankedCandidates: Candidate[]; topCandidates: Candidate[] }> {
  const selectorConfig = buildCandidateSelectorConfigFromEnv(args.env, args.nearThreshold);
  const initialCandidates = selectCandidates(args.scoredCandidates, selectorConfig);

  await applyKlendSdkVerificationToCandidates({
    candidates: initialCandidates,
    env: args.env,
    marketPubkey: args.marketPubkey,
    programId: args.programId,
    rpcUrl: args.rpcUrl,
  });

  const rerankedCandidates = selectCandidates(initialCandidates, selectorConfig);
  return {
    rankedCandidates: rerankedCandidates,
    topCandidates: rerankedCandidates.slice(0, args.topN),
  };
}
