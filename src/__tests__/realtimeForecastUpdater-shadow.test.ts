import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const mocks = vi.hoisted(() => ({
  refreshSubset: vi.fn(),
  loadQueue: vi.fn(),
  promoteWatchedCandidatesToQueue: vi.fn(),
}));

vi.mock('../forecast/forecastManager.js', () => ({
  refreshSubset: mocks.refreshSubset,
}));

vi.mock('../scheduler/txScheduler.js', () => ({
  loadQueue: mocks.loadQueue,
}));

vi.mock('../monitoring/shadowWatchPromotion.js', () => ({
  promoteWatchedCandidatesToQueue: mocks.promoteWatchedCandidatesToQueue,
}));

import { RealtimeForecastUpdater } from '../monitoring/realtimeForecastUpdater.js';

describe('RealtimeForecastUpdater shadow promotion flow', () => {
  it('routes non-queue watch keys to promotion path instead of not-found refresh', async () => {
    mocks.refreshSubset.mockReset();
    mocks.loadQueue.mockReset();
    mocks.promoteWatchedCandidatesToQueue.mockReset();
    mocks.loadQueue.mockReturnValue([]);
    mocks.promoteWatchedCandidatesToQueue.mockResolvedValue({
      considered: 1,
      ranked: 1,
      queueEligible: 1,
      verifiedByKlend: 1,
      admittedByKlend: 1,
      skippedByHealthyCooldown: 0,
      enqueued: 1,
      rejectedReasons: {},
    });

    const updater = new RealtimeForecastUpdater({
      connection: {} as any,
      marketPubkey: PublicKey.unique(),
      programId: PublicKey.unique(),
      reserveCache: { byMint: new Map(), byReserve: new Map() } as any,
      oracleCache: new Map(),
    });

    (updater as any).candidatesByKey.set('watch-only', {
      key: 'watch-only',
      obligationPubkey: 'watch-only',
      healthRatio: 0.99,
      borrowValueUsd: 100,
      repayReservePubkey: 'repay',
      collateralReservePubkey: 'coll',
    });
    (updater as any).enqueueRefresh(['watch-only'], 'rt-oracle-update');

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(mocks.refreshSubset).not.toHaveBeenCalled();
    expect(mocks.promoteWatchedCandidatesToQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        keys: ['watch-only'],
      }),
    );
  });
});
