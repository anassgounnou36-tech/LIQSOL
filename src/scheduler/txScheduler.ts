import fs from 'node:fs';
import path from 'node:path';
import { FlashloanPlan } from './txBuilder.js';

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

export function enqueuePlans(plans: FlashloanPlan[]): FlashloanPlan[] {
  const existing = loadQueue();
  const map = new Map<string, FlashloanPlan>();
  for (const p of existing) map.set(p.key, p);
  for (const p of plans) map.set(p.key, p);
  const all = Array.from(map.values())
    .sort((a, b) => (Number(b.ev) - Number(a.ev)) || (Number(a.ttlMin) - Number(b.ttlMin)) || (Number(b.hazard) - Number(a.hazard)));
  saveQueue(all);
  return all;
}
