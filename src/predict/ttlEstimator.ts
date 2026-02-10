/**
 * Time to Liquidation (TTL) Estimator Module
 * 
 * Provides approximate time-to-liquidation estimation based on health ratio
 * and assumed market conditions (e.g., SOL price drop rate).
 */

/**
 * Candidate data for TTL estimation
 */
export interface TtlCandidate {
  healthRatio?: number;
  healthRatioRaw?: number;
}

/**
 * Estimate time to liquidation as a human-readable string.
 * 
 * Approximates TTL by calculating the required price drop over an assumed
 * SOL drop rate per minute. If data is insufficient, returns 'unknown'.
 * 
 * @param candidate - Candidate object with healthRatio or healthRatioRaw
 * @param opts - Configuration options for TTL estimation
 * @param opts.solDropPctPerMin - Assumed SOL price drop percentage per minute
 * @param opts.maxDropPct - Maximum drop percentage to consider
 * @returns Human-readable time string (e.g., "5m30s", "now", "unknown")
 */
export function estimateTtlString(
  candidate: TtlCandidate,
  opts: { solDropPctPerMin: number; maxDropPct: number }
): string {
  const debugEnabled = (process.env.TTL_DEBUG ?? 'false') === 'true';
  
  try {
    const hr = Number(candidate.healthRatio ?? 0);
    const margin = Math.max(0, hr - 1.0);
    
    if (debugEnabled) {
      console.log('[TTL Debug]', {
        healthRatio: hr,
        distanceToThreshold: margin,
        solDropPctPerMin: opts.solDropPctPerMin,
        maxDropPct: opts.maxDropPct,
      });
    }
    
    if (margin <= 0) {
      if (debugEnabled) console.log('[TTL Debug] Result: now (margin <= 0)');
      return 'now';
    }

    // Very simple mapping: assume linear sensitivity — placeholder.
    // Future PRs can use computeHealthRatio with shocked oracle prices per step.
    const requiredDropPct = Math.min(opts.maxDropPct, margin * 100);
    const minutes = requiredDropPct / Math.max(0.0001, opts.solDropPctPerMin);
    const m = Math.floor(minutes);
    const s = Math.floor((minutes - m) * 60);
    const result = `${m}m${s.toString().padStart(2, '0')}s`;
    
    if (debugEnabled) {
      console.log('[TTL Debug]', {
        requiredDropPct,
        minutes: minutes.toFixed(4),
        clamped: requiredDropPct < margin * 100,
        result,
      });
    }
    
    return result;
  } catch (err) {
    if (debugEnabled) console.log('[TTL Debug] Error:', err);
    return 'unknown';
  }
}
