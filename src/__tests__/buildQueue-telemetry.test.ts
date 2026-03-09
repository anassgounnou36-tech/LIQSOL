import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  replaceQueue: vi.fn(),
  enqueuePlans: vi.fn(),
  emitBotEvent: vi.fn(),
  maybeNotifyForBotEvent: vi.fn(),
}));

vi.mock('../scheduler/txFilters.js', () => ({
  normalizeCandidates: vi.fn((payload: any) => payload),
  filterCandidatesWithStats: vi.fn(() => ({
    filtered: [{ key: 'new-1' }, { key: 'new-2' }],
    stats: {
      total: 3,
      filtered: 2,
      reasons: { evTooLow: 1 },
      forcedIn: { liquidatable: 0 },
    },
  })),
}));

vi.mock('../scheduler/txBuilder.js', () => ({
  buildPlanFromCandidate: vi.fn((c: any) => ({
    key: c.key,
    obligationPubkey: c.key,
    ownerPubkey: c.key,
    repayReservePubkey: 'repay',
    collateralReservePubkey: 'collat',
    repayMint: c.repayMint ?? 'USDC',
    collateralMint: c.collateralMint ?? 'SOL',
    ev: c.ev ?? 0,
    ttlMin: c.ttlMin ?? 1,
    ttlStr: c.ttlStr ?? '1m',
    hazard: c.hazard ?? 0.1,
    evProfitUsd: c.evProfitUsd ?? 0,
    evCostUsd: c.evCostUsd ?? 0,
  })),
}));

vi.mock('../scheduler/txScheduler.js', () => ({
  replaceQueue: mocks.replaceQueue,
  enqueuePlans: mocks.enqueuePlans,
}));

vi.mock('../observability/botTelemetry.js', async () => {
  const actual = await vi.importActual('../observability/botTelemetry.js');
  return {
    ...actual,
    emitBotEvent: mocks.emitBotEvent,
  };
});

vi.mock('../notify/notificationRouter.js', () => ({
  maybeNotifyForBotEvent: mocks.maybeNotifyForBotEvent,
}));

import { buildQueue } from '../pipeline/buildQueue.js';

describe('buildQueue telemetry queue-added diff', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liqsol-buildq-'));
    mocks.replaceQueue.mockReset();
    mocks.enqueuePlans.mockReset();
    mocks.emitBotEvent.mockReset();
    mocks.maybeNotifyForBotEvent.mockReset();
    process.env.TELEGRAM_NOTIFY_MAX_QUEUE_PER_REFRESH = '1';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits queue-opportunity-added only for newly added plans and respects cap', async () => {
    const candidatesPath = path.join(tmpDir, 'candidates.json');
    const queuePath = path.join(tmpDir, 'tx_queue.json');
    fs.writeFileSync(candidatesPath, JSON.stringify([{ key: 'new-1' }, { key: 'new-2' }]));
    fs.writeFileSync(
      queuePath,
      JSON.stringify([
        {
          key: 'existing',
          createdAtMs: 1,
          repayMint: 'USDC',
          collateralMint: 'SOL',
        },
      ]),
    );
    mocks.replaceQueue.mockResolvedValue([
      {
        key: 'existing',
        obligationPubkey: 'existing',
        createdAtMs: 1,
        repayMint: 'USDC',
        collateralMint: 'SOL',
        ev: 2,
        hazard: 0.2,
        ttlMin: 2,
        ttlStr: '2m',
        evProfitUsd: 2,
        evCostUsd: 1,
      },
      {
        key: 'new-1',
        obligationPubkey: 'new-1',
        createdAtMs: 2,
        repayMint: 'USDC',
        collateralMint: 'SOL',
        ev: 11,
        hazard: 0.6,
        ttlMin: 1,
        ttlStr: '1m',
        evProfitUsd: 9,
        evCostUsd: 2,
      },
      {
        key: 'new-2',
        obligationPubkey: 'new-2',
        createdAtMs: 3,
        repayMint: 'USDC',
        collateralMint: 'SOL',
        ev: 5,
        hazard: 0.4,
        ttlMin: 3,
        ttlStr: '3m',
        evProfitUsd: 8,
        evCostUsd: 3,
      },
    ]);

    await buildQueue({ candidatesPath, outputPath: queuePath, mode: 'replace' });

    expect(mocks.emitBotEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'queue-refresh-summary',
        candidateCount: 3,
        filteredCount: 2,
        validPlanCount: 2,
        queueSize: 3,
      }),
    );
    const queueAddedCalls = mocks.emitBotEvent.mock.calls.filter(
      (call) => call[0]?.kind === 'queue-opportunity-added',
    );
    expect(queueAddedCalls).toHaveLength(1);
    expect(queueAddedCalls[0][0]).toEqual(
      expect.objectContaining({
        kind: 'queue-opportunity-added',
        planKey: 'new-1',
      }),
    );
    expect(mocks.maybeNotifyForBotEvent).toHaveBeenCalledTimes(1);
  });
});
