import { loadQueue, saveQueue } from '../scheduler/txScheduler.js';
import { recomputePlanFields } from '../scheduler/txBuilder.js';

export interface RefreshResult {
  key: string;
  before?: any;
  after?: any;
  changed: boolean;
  reason?: string;
}

function nowMs(): number {
  return Date.now();
}

/**
 * Refresh a single obligation forecast in-place within queue using recomputePlanFields.
 * Optionally provide a candidate payload to recompute with fresh source data.
 */
export function refreshObligation(key: string, candidate?: any, reason?: string): RefreshResult {
  const queue = loadQueue();
  if (!Array.isArray(queue) || queue.length === 0) {
    return { key, changed: false, reason: 'empty-queue' };
  }
  const idx = queue.findIndex(p => p.key === key);
  if (idx < 0) return { key, changed: false, reason: 'not-found' };

  const before = queue[idx];
  let after = before;

  try {
    // recomputePlanFields should produce a normalized/updated plan with TTL/EV/hazard recalculated
    after = recomputePlanFields(before, candidate);
    // Update timestamp to reflect freshness
    after.createdAtMs = nowMs();
    queue[idx] = after;
    saveQueue(queue);
  } catch (e) {
    return { key, before, after, changed: false, reason: `recompute-error: ${(e as Error).message}` };
  }

  const changed =
    Number(after.ev ?? 0) !== Number(before.ev ?? 0) ||
    Number(after.hazard ?? 0) !== Number(before.hazard ?? 0) ||
    Number(after.ttlMin ?? Infinity) !== Number(before.ttlMin ?? Infinity) ||
    String(after.ttlStr ?? '') !== String(before.ttlStr ?? '');

  return { key, before, after, changed, reason };
}

/**
 * Refresh multiple obligations. Returns per-key results.
 */
export function refreshSubset(keys: string[], candidatesByKey?: Map<string, any>, reason?: string): RefreshResult[] {
  const results: RefreshResult[] = [];
  for (const key of keys) {
    const candidate = candidatesByKey?.get(key);
    results.push(refreshObligation(key, candidate, reason));
  }
  return results;
}
