import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidateLike } from '../monitoring/realtimeForecastUpdater.js';

const mocks = vi.hoisted(() => ({
  loadQueue: vi.fn(),
  enqueuePlans: vi.fn(),
  selectCandidates: vi.fn(),
  filterCandidatesBySelectedLegUsd: vi.fn(),
  filterCandidatesWithStats: vi.fn(),
  buildPlanFromCandidate: vi.fn(),
  emitBotEvent: vi.fn(),
  maybeNotifyForBotEvent: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  loadEnv: vi.fn(() => ({
    CAND_NEAR: '1.02',
    MIN_SELECTED_REPAY_USD: '0',
    MIN_SELECTED_COLLATERAL_USD: '0',
    SCHED_MIN_EV: '0',
    SCHED_MAX_TTL_MIN: '10',
    SCHED_MIN_HAZARD: '0.05',
    HAZARD_ALPHA: '25',
    TTL_VOLATILE_MOVE_PCT_PER_MIN: '0.2',
    TTL_STABLE_MOVE_PCT_PER_MIN: '0.02',
    TTL_SOL_DROP_PCT_PER_MIN: '0.2',
    TTL_MAX_DROP_PCT: '20',
    EV_CLOSE_FACTOR: '0.5',
    EV_LIQUIDATION_BONUS_PCT: '0.05',
    EV_FLASHLOAN_FEE_PCT: '0.002',
    EV_FIXED_GAS_USD: '0.5',
    EV_MIN_LIQUIDATION_BONUS_PCT: '0.02',
    EV_BONUS_FULLY_SEVERE_HR_GAP: '0.1',
    EV_SAME_MINT_SLIPPAGE_BUFFER_PCT: '0',
  })),
  loadReadonlyEnv: vi.fn(() => ({})),
}));

vi.mock('../strategy/rankCandidatesForSelection.js', () => ({
  buildCandidateSelectorConfigFromEnv: vi.fn(() => ({})),
}));

vi.mock('../scheduler/txScheduler.js', () => ({
  loadQueue: mocks.loadQueue,
  enqueuePlans: mocks.enqueuePlans,
}));

vi.mock('../strategy/candidateSelector.js', () => ({
  selectCandidates: mocks.selectCandidates,
}));

vi.mock('../strategy/selectedLegFilters.js', () => ({
  filterCandidatesBySelectedLegUsd: mocks.filterCandidatesBySelectedLegUsd,
}));

vi.mock('../scheduler/txFilters.js', () => ({
  filterCandidatesWithStats: mocks.filterCandidatesWithStats,
}));

vi.mock('../scheduler/txBuilder.js', () => ({
  buildPlanFromCandidate: mocks.buildPlanFromCandidate,
}));

vi.mock('../observability/botTelemetry.js', async () => {
  const actual = await vi.importActual('../observability/botTelemetry.js');
  return {
    ...actual,
    emitBotEvent: mocks.emitBotEvent,
    makePlanFingerprint: vi.fn((plan: any) => String(plan.key)),
  };
});

vi.mock('../notify/notificationRouter.js', () => ({
  maybeNotifyForBotEvent: mocks.maybeNotifyForBotEvent,
}));

import { promoteWatchedCandidatesToQueue } from '../monitoring/shadowWatchPromotion.js';

function makeCandidate(overrides: Partial<CandidateLike> = {}): CandidateLike {
  return {
    key: 'k1',
    obligationPubkey: 'k1',
    ownerPubkey: 'owner-1',
    healthRatio: 0.99,
    borrowValueUsd: 1000,
    collateralValueUsd: 1200,
    repayReservePubkey: 'repay-1',
    collateralReservePubkey: 'coll-1',
    primaryBorrowMint: 'USDC',
    primaryCollateralMint: 'SOL',
    assets: ['USDC', 'SOL'],
    evContext: {
      selectedBorrowReservePubkey: 'repay-1',
      selectedCollateralReservePubkey: 'coll-1',
      selectedBorrowMint: 'USDC',
      selectedCollateralMint: 'SOL',
      selectedBorrowUsdRaw: 100,
      selectedCollateralUsdRaw: 120,
    },
    ...overrides,
  };
}

describe('promoteWatchedCandidatesToQueue', () => {
  beforeEach(() => {
    mocks.loadQueue.mockReset();
    mocks.enqueuePlans.mockReset();
    mocks.selectCandidates.mockReset();
    mocks.filterCandidatesBySelectedLegUsd.mockReset();
    mocks.filterCandidatesWithStats.mockReset();
    mocks.buildPlanFromCandidate.mockReset();
    mocks.emitBotEvent.mockReset();
    mocks.maybeNotifyForBotEvent.mockReset();

    mocks.loadQueue.mockReturnValue([]);
    mocks.selectCandidates.mockImplementation((candidates) => candidates);
    mocks.filterCandidatesBySelectedLegUsd.mockImplementation((candidates) => ({
      passed: candidates,
      stats: { missingEvContext: 0, repayTooSmall: 0, collateralTooSmall: 0 },
    }));
    mocks.filterCandidatesWithStats.mockImplementation((candidates) => ({
      filtered: candidates,
      stats: {
        reasons: { evTooLow: 0, ttlTooHigh: 0, hazardTooLow: 0, missingHealth: 0, missingBorrow: 0 },
      },
    }));
    mocks.buildPlanFromCandidate.mockImplementation((candidate) => ({
      key: candidate.obligationPubkey,
      obligationPubkey: candidate.obligationPubkey,
      repayReservePubkey: candidate.repayReservePubkey,
      collateralReservePubkey: candidate.collateralReservePubkey,
      repayMint: 'USDC',
      collateralMint: 'SOL',
      ev: 1,
      hazard: 0.3,
      ttlMin: 1,
      ttlStr: '1m',
    }));
    mocks.enqueuePlans.mockImplementation((plans) => plans);
  });

  it('enqueues watch-only candidate when it is queue-eligible', async () => {
    const candidatesByKey = new Map([['k1', makeCandidate()]]);
    const result = await promoteWatchedCandidatesToQueue({ keys: ['k1'], candidatesByKey });

    expect(result.queueEligible).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(mocks.enqueuePlans).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ key: 'k1' })]),
    );
  });

  it('ignores watched candidate already present in queue', async () => {
    mocks.loadQueue.mockReturnValue([{ key: 'k1' }]);
    const candidatesByKey = new Map([['k1', makeCandidate()]]);
    const result = await promoteWatchedCandidatesToQueue({ keys: ['k1'], candidatesByKey });

    expect(result.considered).toBe(0);
    expect(mocks.enqueuePlans).toHaveBeenCalledWith([]);
  });

  it('applies selected-leg filter in promotion path', async () => {
    mocks.filterCandidatesBySelectedLegUsd.mockImplementation(() => ({
      passed: [],
      stats: { missingEvContext: 1, repayTooSmall: 0, collateralTooSmall: 0 },
    }));
    const candidatesByKey = new Map([['k1', makeCandidate()]]);
    const result = await promoteWatchedCandidatesToQueue({ keys: ['k1'], candidatesByKey });

    expect(result.ranked).toBe(1);
    expect(result.queueEligible).toBe(0);
    expect(result.rejectedReasons.selectedLegMissingEvContext).toBe(1);
  });

  it('applies queue filters in promotion path', async () => {
    mocks.filterCandidatesWithStats.mockImplementation(() => ({
      filtered: [],
      stats: {
        reasons: { evTooLow: 1, ttlTooHigh: 0, hazardTooLow: 0, missingHealth: 0, missingBorrow: 0 },
      },
    }));
    const candidatesByKey = new Map([['k1', makeCandidate()]]);
    const result = await promoteWatchedCandidatesToQueue({ keys: ['k1'], candidatesByKey });

    expect(result.queueEligible).toBe(0);
    expect(result.rejectedReasons.queueEvTooLow).toBe(1);
  });

  it('emits queue-opportunity-added telemetry shape for promoted plans', async () => {
    const candidatesByKey = new Map([['k1', makeCandidate()]]);
    await promoteWatchedCandidatesToQueue({ keys: ['k1'], candidatesByKey });

    const queueAdded = mocks.emitBotEvent.mock.calls.find((call) => call[0]?.kind === 'queue-opportunity-added');
    expect(queueAdded?.[0]).toEqual(
      expect.objectContaining({
        kind: 'queue-opportunity-added',
        planKey: 'k1',
        obligationPubkey: 'k1',
      }),
    );
    expect(mocks.maybeNotifyForBotEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'queue-opportunity-added',
        planKey: 'k1',
      }),
    );
  });
});
