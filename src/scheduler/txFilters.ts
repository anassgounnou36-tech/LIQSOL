import { scoreHazard } from '../predict/hazardScorer.js';
import { computeEV, type EvParams } from '../predict/evCalculator.js';
import { estimateTtlString } from '../predict/ttlEstimator.js';

export interface FilterParams {
  minEv: number;
  maxTtlMin: number;
  minHazard: number;
  hazardAlpha: number;
  evParams: EvParams;
  ttlDropPerMinPct: number;
  ttlMaxDropPct: number;
}

export interface FilterStats {
  total: number;
  filtered: number;
  reasons: {
    evTooLow: number;
    ttlTooHigh: number;
    hazardTooLow: number;
    missingHealth: number;
    missingBorrow: number;
  };
  forcedIn: {
    liquidatable: number;
  };
}

export function normalizeCandidates(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.candidates)) return payload.candidates;
  return Object.values(payload);
}

export function parseTtlMinutes(ttlStr?: string): number {
  if (!ttlStr || ttlStr === 'unknown') return Infinity;
  const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(ttlStr);
  if (!m) return Infinity;
  const minutes = Number(m[1] || 0);
  const seconds = Number(m[2] || 0);
  return minutes + seconds / 60;
}

export function filterCandidates(raw: any[], p: FilterParams): any[] {
  return raw
    .map((c) => {
      const hr = Number(c.healthRatioRaw ?? c.healthRatio ?? 0);
      const hazard = c.hazard ?? scoreHazard(hr, p.hazardAlpha);
      const borrowUsd = Number(c.borrowValueUsd ?? 0);
      const ev = c.ev ?? computeEV(borrowUsd, hazard, p.evParams);
      const ttlStr = c.forecast?.timeToLiquidation ??
        estimateTtlString(c, { solDropPctPerMin: p.ttlDropPerMinPct, maxDropPct: p.ttlMaxDropPct });
      const ttlMin = parseTtlMinutes(ttlStr);
      const liquidationEligible = c.liquidationEligible ?? false;
      return { ...c, key: c.key ?? c.obligationPubkey ?? 'unknown', hazard, ev, ttlStr, ttlMin, borrowUsd, liquidationEligible };
    })
    .filter((c) => c.ev > p.minEv && c.ttlMin <= p.maxTtlMin && c.hazard > p.minHazard);
}

export function filterCandidatesWithStats(raw: any[], p: FilterParams): { filtered: any[]; stats: FilterStats } {
  const stats: FilterStats = {
    total: raw.length,
    filtered: 0,
    reasons: {
      evTooLow: 0,
      ttlTooHigh: 0,
      hazardTooLow: 0,
      missingHealth: 0,
      missingBorrow: 0,
    },
    forcedIn: {
      liquidatable: 0,
    },
  };

  const enriched = raw.map((c) => {
    const hr = Number(c.healthRatioRaw ?? c.healthRatio ?? 0);
    const hazard = c.hazard ?? scoreHazard(hr, p.hazardAlpha);
    const borrowUsd = Number(c.borrowValueUsd ?? 0);
    const ev = c.ev ?? computeEV(borrowUsd, hazard, p.evParams);
    const ttlStr = c.forecast?.timeToLiquidation ??
      estimateTtlString(c, { solDropPctPerMin: p.ttlDropPerMinPct, maxDropPct: p.ttlMaxDropPct });
    const ttlMin = parseTtlMinutes(ttlStr);
    const liquidationEligible = c.liquidationEligible ?? false;
    return { ...c, key: c.key ?? c.obligationPubkey ?? 'unknown', hazard, ev, ttlStr, ttlMin, borrowUsd, liquidationEligible };
  });

  const filtered = enriched.filter((c) => {
    // Force-include liquidatable obligations
    if (c.liquidationEligible) {
      stats.forcedIn.liquidatable++;
      return true;
    }

    // Check filter reasons
    const hasHealth = c.healthRatioRaw != null || c.healthRatio != null;
    const hasBorrow = c.borrowValueUsd != null && Number(c.borrowValueUsd) > 0;

    if (!hasHealth) {
      stats.reasons.missingHealth++;
      return false;
    }
    if (!hasBorrow) {
      stats.reasons.missingBorrow++;
      return false;
    }
    if (c.ev <= p.minEv) {
      stats.reasons.evTooLow++;
      return false;
    }
    if (c.ttlMin > p.maxTtlMin) {
      stats.reasons.ttlTooHigh++;
      return false;
    }
    if (c.hazard <= p.minHazard) {
      stats.reasons.hazardTooLow++;
      return false;
    }

    return true;
  });

  stats.filtered = filtered.length;
  return { filtered, stats };
}
