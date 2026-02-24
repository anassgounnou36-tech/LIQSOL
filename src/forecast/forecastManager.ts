import { getQueueMtimeMs, loadQueue, saveQueue } from '../scheduler/txScheduler.js';
import { recomputePlanFields, type FlashloanPlan } from '../scheduler/txBuilder.js';

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
  const result = refreshSubset(
    [key],
    candidate === undefined ? undefined : new Map([[key, candidate]]),
    reason
  )[0];
  return result ?? { key, changed: false, reason: 'not-found' };
}

/**
 * Refresh multiple obligations. Returns per-key results.
 */
export function refreshSubset(keys: string[], candidatesByKey?: Map<string, any>, reason?: string): RefreshResult[] {
  const beforeMtime = getQueueMtimeMs();
  let queue = loadQueue();
  const results: RefreshResult[] = [];
  if (!Array.isArray(queue) || queue.length === 0) {
    return keys.map((key) => ({ key, changed: false, reason: 'empty-queue' }));
  }

  const indexByKey = new Map<string, number>();
  for (let i = 0; i < queue.length; i++) {
    indexByKey.set(queue[i].key, i);
  }

  const updatesByKey = new Map<string, FlashloanPlan>();

  for (const key of keys) {
    const idx = indexByKey.get(key);
    if (idx === undefined) {
      results.push({ key, changed: false, reason: 'not-found' });
      continue;
    }

    const before = queue[idx];
    let after = before;
    const candidate = candidatesByKey?.get(key);

    try {
      after = recomputePlanFields(before, candidate);
      after.createdAtMs = nowMs();
      queue[idx] = after;
      updatesByKey.set(key, after);
    } catch (e) {
      results.push({ key, before, after, changed: false, reason: `recompute-error: ${(e as Error).message}` });
      continue;
    }

    const changed =
      Number(after.ev ?? 0) !== Number(before.ev ?? 0) ||
      Number(after.hazard ?? 0) !== Number(before.hazard ?? 0) ||
      Number(after.ttlMin ?? Infinity) !== Number(before.ttlMin ?? Infinity) ||
      String(after.ttlStr ?? '') !== String(before.ttlStr ?? '');

    results.push({ key, before, after, changed, reason });
  }

  if (updatesByKey.size > 0) {
    const afterMtime = getQueueMtimeMs();
    if (afterMtime !== beforeMtime) {
      const latestQueue = loadQueue();
      for (let i = 0; i < latestQueue.length; i++) {
        const updated = updatesByKey.get(latestQueue[i].key);
        if (updated) latestQueue[i] = updated;
      }
      queue = latestQueue;
    }
    saveQueue(queue);
  }

  return results;
}
