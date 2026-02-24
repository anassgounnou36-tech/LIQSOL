import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadQueue, saveQueue } from '../scheduler/txScheduler.js';
import { refreshSubset } from '../forecast/forecastManager.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';

const TEST_QUEUE_PATH = path.join(process.cwd(), 'data', 'tx_queue.json');

function makePlan(key: string, ev: number): FlashloanPlan {
  return {
    planVersion: 2,
    key,
    obligationPubkey: key,
    ownerPubkey: `owner-${key}`,
    mint: 'USDC',
    amountUsd: 100,
    amountUi: '100.00',
    repayMint: 'repay-mint',
    collateralMint: 'collateral-mint',
    repayReservePubkey: 'repay-reserve',
    collateralReservePubkey: 'collateral-reserve',
    ev,
    hazard: 0.1,
    ttlMin: 10,
    ttlStr: '10m00s',
    createdAtMs: 1,
    predictedLiquidationAtMs: null,
    liquidationEligible: false,
    assets: ['mint-a'],
  };
}

describe('forecastManager refreshSubset batch update', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_QUEUE_PATH)) fs.unlinkSync(TEST_QUEUE_PATH);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_QUEUE_PATH)) fs.unlinkSync(TEST_QUEUE_PATH);
  });

  it('updates selected keys and preserves untouched queue entries', () => {
    const initial = [makePlan('k1', 5), makePlan('k2', 6), makePlan('k3', 7)];
    saveQueue(initial);

    const candidatesByKey = new Map([
      ['k1', { borrowValueUsd: 150, healthRatio: 1.05, healthRatioRaw: 1.05 }],
      ['k2', { borrowValueUsd: 220, healthRatio: 1.01, healthRatioRaw: 1.01 }],
    ]);

    const results = refreshSubset(['k1', 'k2'], candidatesByKey, 'batch-test');

    expect(results).toHaveLength(2);
    expect(results.every(r => r.reason === 'batch-test')).toBe(true);

    const raw = fs.readFileSync(TEST_QUEUE_PATH, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();

    const queue = loadQueue();
    expect(queue).toHaveLength(3);

    const k1 = queue.find(p => p.key === 'k1');
    const k2 = queue.find(p => p.key === 'k2');
    const k3 = queue.find(p => p.key === 'k3');

    expect(k1?.createdAtMs).toBeGreaterThan(1);
    expect(k2?.createdAtMs).toBeGreaterThan(1);
    expect(k3?.ev).toBe(7);
    expect(k3?.createdAtMs).toBe(1);
  });
});
