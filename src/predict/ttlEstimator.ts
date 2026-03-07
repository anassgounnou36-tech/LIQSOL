import type { PairAwareTtlContext, TtlLegContext } from './ttlContext.js';

/**
 * Candidate data for TTL estimation
 */
export interface TtlCandidate {
  healthRatio?: number;
  healthRatioRaw?: number;
  ttlContext?: PairAwareTtlContext;
}

export interface TtlEstimate {
  ttlString: string;
  ttlMinutes: number | null;
  model: 'pair-collateral-shock' | 'pair-borrow-shock' | 'legacy-global';
  confidence: 'high' | 'medium' | 'low';
  driverMint?: string;
  driverSide?: 'deposit' | 'borrow';
  requiredMovePct?: number;
}

// Cache debug flag to avoid repeated environment variable lookups
const TTL_DEBUG_ENABLED = (process.env.TTL_DEBUG ?? 'false') === 'true';

function formatTtl(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return 'unknown';
  const m = Math.floor(minutes);
  const s = Math.floor((minutes - m) * 60);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function getConfidence(
  ttlContext: PairAwareTtlContext,
  chosenLegShareOfWeightedSide: number
): 'high' | 'medium' | 'low' {
  if (ttlContext.activeDepositCount === 1 && ttlContext.activeBorrowCount === 1) {
    return 'high';
  }
  if (chosenLegShareOfWeightedSide >= 0.6) {
    return 'medium';
  }
  return 'low';
}

export function estimateTtl(
  candidate: TtlCandidate,
  opts: {
    volatileMovePctPerMin: number;
    stableMovePctPerMin: number;
    maxMovePct: number;
    legacySolDropPctPerMin: number;
  }
): TtlEstimate {
  try {
    const hr = Number(candidate.healthRatioRaw ?? candidate.healthRatio ?? 0);

    if (TTL_DEBUG_ENABLED) {
      console.log('[TTL Debug]', {
        healthRatio: hr,
        hasTtlContext: Boolean(candidate.ttlContext),
        volatileMovePctPerMin: opts.volatileMovePctPerMin,
        stableMovePctPerMin: opts.stableMovePctPerMin,
        maxMovePct: opts.maxMovePct,
        legacySolDropPctPerMin: opts.legacySolDropPctPerMin,
      });
    }

    if (hr <= 1) {
      return { ttlString: 'now', ttlMinutes: 0, model: 'legacy-global', confidence: 'high' };
    }

    if (candidate.ttlContext) {
      const ttlContext = candidate.ttlContext;
      const bufferUsdAdj = ttlContext.totalCollateralUsdAdj - ttlContext.totalBorrowUsdAdj;

      if (bufferUsdAdj <= 0) {
        return { ttlString: 'now', ttlMinutes: 0, model: 'legacy-global', confidence: 'high' };
      }

      const pairCandidates: Array<{
        minutes: number;
        requiredMovePct: number;
        side: 'deposit' | 'borrow';
        leg: TtlLegContext;
      }> = [];

      for (const leg of ttlContext.deposits) {
        const requiredMovePct = (bufferUsdAdj / leg.usdWeighted) * 100;
        const rate = leg.assetClass === 'stable' ? opts.stableMovePctPerMin : opts.volatileMovePctPerMin;
        if (rate > 0 && requiredMovePct > 0) {
          const minutes = requiredMovePct / rate;
          if (
            Number.isFinite(requiredMovePct) &&
            requiredMovePct > 0 &&
            requiredMovePct <= opts.maxMovePct &&
            Number.isFinite(minutes) &&
            minutes >= 0
          ) {
            pairCandidates.push({ minutes, requiredMovePct, side: 'deposit', leg });
          }
        }
      }

      for (const leg of ttlContext.borrows) {
        const requiredMovePct = (bufferUsdAdj / leg.usdWeighted) * 100;
        const rate = leg.assetClass === 'stable' ? opts.stableMovePctPerMin : opts.volatileMovePctPerMin;
        if (rate > 0 && requiredMovePct > 0) {
          const minutes = requiredMovePct / rate;
          if (
            Number.isFinite(requiredMovePct) &&
            requiredMovePct > 0 &&
            requiredMovePct <= opts.maxMovePct &&
            Number.isFinite(minutes) &&
            minutes >= 0
          ) {
            pairCandidates.push({ minutes, requiredMovePct, side: 'borrow', leg });
          }
        }
      }

      if (pairCandidates.length > 0) {
        const best = pairCandidates.reduce((prev, curr) => (curr.minutes < prev.minutes ? curr : prev));
        const model = best.side === 'deposit' ? 'pair-collateral-shock' : 'pair-borrow-shock';
        return {
          ttlString: formatTtl(best.minutes),
          ttlMinutes: best.minutes,
          model,
          confidence: getConfidence(ttlContext, best.leg.shareOfWeightedSide),
          driverMint: best.leg.mint,
          driverSide: best.side,
          requiredMovePct: best.requiredMovePct,
        };
      }
    }

    const requiredDropPct = Math.min(opts.maxMovePct, Math.max(0, hr - 1) * 100);
    const minutes = requiredDropPct / opts.legacySolDropPctPerMin;
    if (!Number.isFinite(minutes) || minutes < 0) {
      return { ttlString: 'unknown', ttlMinutes: null, model: 'legacy-global', confidence: 'low' };
    }
    return {
      ttlString: formatTtl(minutes),
      ttlMinutes: minutes,
      model: 'legacy-global',
      confidence: 'low',
    };
  } catch (err) {
    if (TTL_DEBUG_ENABLED) console.log('[TTL Debug] Error:', err);
    return { ttlString: 'unknown', ttlMinutes: null, model: 'legacy-global', confidence: 'low' };
  }
}

export function estimateTtlString(
  candidate: TtlCandidate,
  opts: { solDropPctPerMin: number; maxDropPct: number }
): string {
  return estimateTtl(candidate, {
    volatileMovePctPerMin: opts.solDropPctPerMin,
    stableMovePctPerMin: 0.02,
    maxMovePct: opts.maxDropPct,
    legacySolDropPctPerMin: opts.solDropPctPerMin,
  }).ttlString;
}
