import fs from 'node:fs';
import path from 'node:path';
import { FlashloanPlan, recomputePlanFields } from './txBuilder.js';
import { evaluateForecasts, type ForecastEntry, parseTtlMinutes, type TtlManagerParams } from '../predict/forecastTTLManager.js';
import { isPlanComplete, getMissingFields } from './planValidation.js';
import { writeJsonAtomic } from '../shared/fs.js';

const QUEUE_PATH = path.join(process.cwd(), 'data', 'tx_queue.json');

export function loadQueue(): FlashloanPlan[] {
  if (!fs.existsSync(QUEUE_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
  } catch (err) {
    console.warn(`Failed to load queue from ${QUEUE_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export function saveQueue(items: FlashloanPlan[]): void {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(items, null, 2));
}

/**
 * Replace entire queue with new plans (atomic write)
 * Use this for production to avoid stale plans lingering
 */
export async function replaceQueue(plans: FlashloanPlan[]): Promise<FlashloanPlan[]> {
  // Sort deterministically: EV desc, TTL asc, hazard desc
  const sorted = [...plans].sort((a, b) => {
    const evDiff = Number(b.ev ?? 0) - Number(a.ev ?? 0);
    if (evDiff !== 0) return evDiff;
    
    const ttlDiff = Number(a.ttlMin ?? Infinity) - Number(b.ttlMin ?? Infinity);
    if (ttlDiff !== 0) return ttlDiff;
    
    return Number(b.hazard ?? 0) - Number(a.hazard ?? 0);
  });
  
  await writeJsonAtomic(QUEUE_PATH, sorted);
  return sorted;
}

/**
 * Drop a specific plan from the queue (for stale plan pruning)
 */
export async function dropPlanFromQueue(planKey: string): Promise<void> {
  const q = loadQueue();
  const filtered = q.filter(p => String(p.key) !== String(planKey));
  await writeJsonAtomic(QUEUE_PATH, filtered);
}

export async function downgradeBlockedPlan(planKey: string, blockedReason = 'blocked-insufficient-rent'): Promise<void> {
  const q = loadQueue();
  let updated = false;
  const downgraded = q.map(plan => {
    if (String(plan.key) !== String(planKey)) return plan;
    updated = true;
    return {
      ...plan,
      ttlMin: 999999,
      ttlStr: blockedReason,
      liquidationEligible: false,
    };
  });
  if (updated) {
    await writeJsonAtomic(QUEUE_PATH, downgraded);
  }
}

export function enqueuePlans(plans: FlashloanPlan[]): FlashloanPlan[] {
  const existing = loadQueue();
  const map = new Map<string, FlashloanPlan>();
  
  // Filter out legacy/incomplete plans from existing queue
  let legacyDroppedCount = 0;
  for (const p of existing) {
    if (!isPlanComplete(p)) {
      legacyDroppedCount++;
      const missing = getMissingFields(p);
      console.log(
        `[Scheduler] drop_legacy_incomplete_plan: ${p.key} ` +
        `(repayReserve=${missing.repayReservePubkey}, ` +
        `collateralReserve=${missing.collateralReservePubkey}, ` +
        `collateralMint=${missing.collateralMint})`
      );
      continue;
    }
    map.set(p.key, p);
  }
  
  if (legacyDroppedCount > 0) {
    console.log(`[Scheduler] Dropped ${legacyDroppedCount} legacy/incomplete plan(s) from existing queue`);
  }
  
  // Validate and enqueue new plans
  let skippedCount = 0;
  for (const p of plans) {
    // Validate plan completeness using shared validation function
    if (!isPlanComplete(p)) {
      skippedCount++;
      const missing = getMissingFields(p);
      console.log(
        `[Scheduler] skip_incomplete_plan: ${p.key} ` +
        `(repayReserve=${missing.repayReservePubkey}, ` +
        `collateralReserve=${missing.collateralReservePubkey}, ` +
        `collateralMint=${missing.collateralMint})`
      );
      continue;
    }
    
    map.set(p.key, p);
  }
  
  if (skippedCount > 0) {
    console.log(`[Scheduler] Skipped ${skippedCount} incomplete plan(s)`);
  }
  
  const all = Array.from(map.values())
    .sort((a, b) => {
      // Primary: liquidationEligible (true first)
      const liqDiff = (b.liquidationEligible ? 1 : 0) - (a.liquidationEligible ? 1 : 0);
      if (liqDiff !== 0) return liqDiff;
      
      // Secondary: EV desc
      const evDiff = Number(b.ev) - Number(a.ev);
      if (evDiff !== 0) return evDiff;
      
      // Tertiary: TTL asc
      const ttlDiff = Number(a.ttlMin) - Number(b.ttlMin);
      if (ttlDiff !== 0) return ttlDiff;
      
      // Quaternary: hazard desc
      return Number(b.hazard) - Number(a.hazard);
    });
  saveQueue(all);
  return all;
}

export function normalizeCandidates(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.candidates)) return payload.candidates;
  return Object.values(payload);
}

export function refreshQueue(params: TtlManagerParams, candidateSource?: any[]): FlashloanPlan[] {
  const queue = loadQueue();
  if (queue.length === 0) return queue;

  // Build forecast entries from queue
  const forecasts: ForecastEntry[] = queue.map(q => ({
    key: q.key,
    ev: Number(q.ev ?? 0),
    hazard: Number(q.hazard ?? 0),
    ttlStr: q.ttlStr,
    ttlMin: q.ttlMin ?? parseTtlMinutes(q.ttlStr),
    forecastUpdatedAtMs: Number(q.createdAtMs ?? 0),
  }));

  const prevEvByKey = new Map<string, number>();
  for (const q of queue) prevEvByKey.set(q.key, Number(q.ev ?? 0));

  const evaluated = evaluateForecasts(forecasts, params, { prevEvByKey });
  const toRefresh = evaluated.filter(e => e.needsRecompute);

  if (toRefresh.length === 0) return queue;

  // Batch limit to cap recompute work per cycle
  const batchLimit = Number(process.env.SCHED_REFRESH_BATCH_LIMIT ?? 25);
  const toRefreshLimited = toRefresh.slice(0, batchLimit);
  
  console.log(`Refreshing ${toRefreshLimited.length}/${toRefresh.length} flagged items (batch limit: ${batchLimit})`);

  const sourceByKey = new Map<string, any>();
  if (candidateSource && Array.isArray(candidateSource)) {
    for (const c of candidateSource) {
      const key = c.key ?? c.obligationPubkey ?? 'unknown';
      sourceByKey.set(key, c);
    }
  }

  const refreshed = queue.map(plan => {
    const evalItem = toRefreshLimited.find(e => e.key === plan.key);
    if (!evalItem) return plan;
    const candidateLike = sourceByKey.get(plan.key) ?? {
      obligationPubkey: plan.key,
      ownerPubkey: plan.ownerPubkey,
      borrowValueUsd: plan.amountUsd,
      healthRatio: undefined,
      healthRatioRaw: undefined,
    };
    return recomputePlanFields(plan, candidateLike);
  });

  const sorted = refreshed.sort((a, b) => {
    // Primary: liquidationEligible (true first)
    const liqDiff = (b.liquidationEligible ? 1 : 0) - (a.liquidationEligible ? 1 : 0);
    if (liqDiff !== 0) return liqDiff;
    
    // Secondary: EV desc
    const evDiff = Number(b.ev) - Number(a.ev);
    if (evDiff !== 0) return evDiff;
    
    // Tertiary: TTL asc
    const ttlDiff = Number(a.ttlMin) - Number(b.ttlMin);
    if (ttlDiff !== 0) return ttlDiff;
    
    // Quaternary: hazard desc
    return Number(b.hazard) - Number(a.hazard);
  });
  saveQueue(sorted);
  return sorted;
}

let refreshInProgress = false;

export function startSchedulerRefreshLoop(params: TtlManagerParams, candidateSource?: any[]): () => void {
  const intervalMs = Number(process.env.SCHED_REFRESH_INTERVAL_MS ?? 30000);
  const intervalId = setInterval(() => {
    // Prevent concurrent refreshes
    if (refreshInProgress) {
      console.log('\n⏭️  Scheduler refresh: skipping (previous refresh still in progress)');
      return;
    }
    refreshInProgress = true;
    try {
      const updated = refreshQueue(params, candidateSource);
      console.log(`\n🔁 Scheduler refresh: queue size ${updated.length}`);
    } catch (err) {
      console.error('Scheduler refresh error:', err);
    } finally {
      refreshInProgress = false;
    }
  }, intervalMs);
  
  // Return cleanup function
  return () => clearInterval(intervalId);
}
