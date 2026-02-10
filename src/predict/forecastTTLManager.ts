/**
 * Forecast TTL Manager
 * - Validates freshness (cache age) and urgency (time-to-liquidation)
 * - Determines whether a forecasted entry needs recompute or can be kept
 */

export interface ForecastEntry {
  key: string;
  ev: number;
  hazard: number;
  ttlStr?: string;      // e.g., "5m30s" or "now" or "unknown"
  ttlMin?: number | null;      // parsed minutes from ttlStr, null for unknown
  predictedLiquidationAtMs?: number | null; // absolute epoch timestamp
  forecastUpdatedAtMs: number; // when this forecast was produced
}

export interface TtlManagerParams {
  // Freshness
  forecastMaxAgeMs: number;         // e.g., 300_000 (5 min)
  minRefreshIntervalMs?: number;    // optional per-candidate min interval, e.g., 60_000
  // Urgency - grace period for TTL expiry
  ttlExpiredMarginMin?: number;     // Deprecated: use ttlGraceMs instead
  ttlGraceMs?: number;              // e.g., 60000 (60s) - grace period for TTL=0
  // EV drop trigger (relative %)
  evDropPct: number;                // e.g., 0.15 (15%)
  // Absolute EV lower bound
  minEv: number;                    // e.g., 0
  // Allow unknown TTL
  ttlUnknownPasses?: boolean;       // e.g., true - treat unknown TTL as non-expired
}

export type ForecastWithFlags = ForecastEntry & {
  expired: boolean;        // based on TTL urgency and/or freshness
  needsRecompute: boolean; // based on EV triggers or exceeded max-age
  reason?: string;         // human-readable reason (e.g., "age", "ttl", "ev_drop", "min_ev")
  prevEv?: number;         // set when comparing deltas (if available from queue)
};

/**
 * Parse TTL string into minutes. Unknown or invalid returns null.
 */
export function parseTtlMinutes(ttlStr?: string): number | null {
  if (!ttlStr || ttlStr === 'unknown') return null;
  if (ttlStr === 'now') return 0;
  const m = /^(\d+)m(\d+)s$/.exec(ttlStr);
  if (!m) return null;
  return Number(m[1]) + Number(m[2]) / 60;
}

/**
 * Mark expired and recompute flags for each forecast.
 * Uses absolute timestamp + grace period for TTL expiry.
 * prevEvByKey can be supplied to evaluate relative EV drop.
 */
export function evaluateForecasts(
  forecasts: ForecastEntry[],
  params: TtlManagerParams,
  opts?: { prevEvByKey?: Map<string, number>; nowMs?: number }
): ForecastWithFlags[] {
  const now = opts?.nowMs ?? Date.now();
  const out: ForecastWithFlags[] = [];
  const ttlGraceMs = params.ttlGraceMs ?? 60_000; // Default 60s grace
  const ttlUnknownPasses = params.ttlUnknownPasses ?? true;

  for (const f of forecasts) {
    const ttlMin = f.ttlMin ?? parseTtlMinutes(f.ttlStr);
    const ageMs = now - f.forecastUpdatedAtMs;

    let expired = false;
    let needsRecompute = false;
    let reason: string | undefined;

    // Freshness expiry
    if (ageMs > params.forecastMaxAgeMs) {
      expired = true;
      needsRecompute = true;
      reason = 'age';
    }

    // TTL-based expiry using absolute timestamp + grace
    if (ttlMin === null) {
      // Unknown TTL
      if (!ttlUnknownPasses) {
        expired = true;
        needsRecompute = true;
        reason = reason ? `${reason},ttl_unknown` : 'ttl_unknown';
      }
    } else if (ttlMin < 0) {
      // Negative TTL means already expired
      expired = true;
      needsRecompute = true;
      reason = reason ? `${reason},ttl_negative` : 'ttl_negative';
    } else if (f.predictedLiquidationAtMs != null) {
      // Check if now > predictedLiquidationAtMs + grace
      if (now > f.predictedLiquidationAtMs + ttlGraceMs) {
        expired = true;
        needsRecompute = true;
        reason = reason ? `${reason},ttl_grace_exceeded` : 'ttl_grace_exceeded';
      }
    }

    // EV-based triggers
    if (f.ev <= params.minEv) {
      needsRecompute = true;
      reason = reason ? `${reason},min_ev` : 'min_ev';
    } else if (opts?.prevEvByKey && opts.prevEvByKey.has(f.key)) {
      const prevEv = opts.prevEvByKey.get(f.key)!;
      if (prevEv > 0) {
        const relDrop = (prevEv - f.ev) / prevEv;
        if (relDrop >= params.evDropPct) {
          needsRecompute = true;
          reason = reason ? `${reason},ev_drop` : 'ev_drop';
        }
      }
    }

    // Per-candidate throttle: defer recompute if not expired and too fresh
    const minInterval = params.minRefreshIntervalMs ?? 0;
    if (!expired && needsRecompute && ageMs < minInterval) {
      needsRecompute = false;
      reason = reason ? `${reason},throttle` : 'throttle';
    }

    out.push({
      ...f,
      ttlMin,
      expired,
      needsRecompute,
      reason,
      prevEv: opts?.prevEvByKey?.get(f.key),
    });
  }

  return out;
}

export function getExpiredForecasts(items: ForecastWithFlags[]): ForecastWithFlags[] {
  return items.filter(i => i.expired);
}

export function filterActiveForecasts(items: ForecastWithFlags[]): ForecastWithFlags[] {
  return items.filter(i => !i.expired);
}

export function needsRecompute(item: ForecastWithFlags): boolean {
  return item.needsRecompute === true;
}
