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
  getKlendSdkVerifier: vi.fn(),
}));
const envState = vi.hoisted(() => ({
  SHADOW_PROMOTION_KLEND_VERIFY_ENABLED: 'true',
  SHADOW_PROMOTION_KLEND_VERIFY_TOPK: '5',
  SHADOW_PROMOTION_KLEND_VERIFY_MAX_TTL_MIN: '15',
  SHADOW_PROMOTION_KLEND_HEALTHY_COOLDOWN_MS: '0',
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
    SHADOW_PROMOTION_KLEND_VERIFY_ENABLED: envState.SHADOW_PROMOTION_KLEND_VERIFY_ENABLED,
    SHADOW_PROMOTION_KLEND_VERIFY_TOPK: envState.SHADOW_PROMOTION_KLEND_VERIFY_TOPK,
    SHADOW_PROMOTION_KLEND_VERIFY_MAX_TTL_MIN: envState.SHADOW_PROMOTION_KLEND_VERIFY_MAX_TTL_MIN,
    SHADOW_PROMOTION_KLEND_HEALTHY_COOLDOWN_MS: envState.SHADOW_PROMOTION_KLEND_HEALTHY_COOLDOWN_MS,
    LIQSOL_RECOMPUTED_VERIFY_TTL_MS: '15000',
    RPC_PRIMARY: 'http://rpc.local',
  })),
  loadReadonlyEnv: vi.fn(() => ({
    KAMINO_MARKET_PUBKEY: '11111111111111111111111111111111',
    KAMINO_KLEND_PROGRAM_ID: '11111111111111111111111111111111',
  })),
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

vi.mock('../engine/klendSdkVerifier.js', () => ({
  getKlendSdkVerifier: mocks.getKlendSdkVerifier,
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
    envState.SHADOW_PROMOTION_KLEND_VERIFY_ENABLED = 'true';
    envState.SHADOW_PROMOTION_KLEND_VERIFY_TOPK = '5';
    envState.SHADOW_PROMOTION_KLEND_VERIFY_MAX_TTL_MIN = '15';
    envState.SHADOW_PROMOTION_KLEND_HEALTHY_COOLDOWN_MS = '0';
    mocks.loadQueue.mockReset();
    mocks.enqueuePlans.mockReset();
    mocks.selectCandidates.mockReset();
    mocks.filterCandidatesBySelectedLegUsd.mockReset();
    mocks.filterCandidatesWithStats.mockReset();
    mocks.buildPlanFromCandidate.mockReset();
    mocks.emitBotEvent.mockReset();
    mocks.maybeNotifyForBotEvent.mockReset();
    mocks.getKlendSdkVerifier.mockReset();

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
    mocks.getKlendSdkVerifier.mockReturnValue({
      verify: vi.fn().mockResolvedValue({
        ok: true,
        healthRatioSdk: 0.99,
        healthRatioSdkRaw: 0.99,
      }),
    });
  });

  it('does not enqueue recompute-eligible watch-only candidate when klend says healthy', async () => {
    mocks.getKlendSdkVerifier.mockReturnValue({
      verify: vi.fn().mockResolvedValue({
        ok: true,
        healthRatioSdk: 1.01,
        healthRatioSdkRaw: 1.01,
      }),
    });
    const candidatesByKey = new Map([
      ['k1', makeCandidate({ rankBucket: 'near-ready', forecast: { ttlMinutes: 5 } })],
    ]);
    const result = await promoteWatchedCandidatesToQueue({ keys: ['k1'], candidatesByKey });

    expect(result.queueEligible).toBe(1);
    expect(result.verifiedByKlend).toBe(1);
    expect(result.admittedByKlend).toBe(0);
    expect(result.enqueued).toBe(0);
    expect(result.rejectedReasons.shadowPromotionKlendHealthy).toBe(1);
    expect(mocks.enqueuePlans).toHaveBeenCalledWith([]);
  });

  it('enqueues watch-only candidate only when klend says hr < 1', async () => {
    mocks.getKlendSdkVerifier.mockReturnValue({
      verify: vi.fn().mockResolvedValue({
        ok: true,
        healthRatioSdk: 0.95,
        healthRatioSdkRaw: 0.95,
      }),
    });
    const candidatesByKey = new Map([
      ['k1', makeCandidate({ rankBucket: 'near-ready', forecast: { ttlMinutes: 5 } })],
    ]);
    const result = await promoteWatchedCandidatesToQueue({ keys: ['k1'], candidatesByKey });

    expect(result.verifiedByKlend).toBe(1);
    expect(result.admittedByKlend).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(mocks.enqueuePlans).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ key: 'k1' })]),
    );
  });

  it('does not enqueue candidates outside bounded klend topK admission pool', async () => {
    envState.SHADOW_PROMOTION_KLEND_VERIFY_TOPK = '1';
    const candidatesByKey = new Map([
      ['k1', makeCandidate({ key: 'k1', obligationPubkey: 'k1', rankBucket: 'near-ready', forecast: { ttlMinutes: 5 } })],
      ['k2', makeCandidate({ key: 'k2', obligationPubkey: 'k2', rankBucket: 'near-ready', forecast: { ttlMinutes: 5 } })],
    ]);
    const result = await promoteWatchedCandidatesToQueue({ keys: ['k1', 'k2'], candidatesByKey });

    expect(result.queueEligible).toBe(2);
    expect(result.verifiedByKlend).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(result.rejectedReasons.shadowPromotionNotInKlendVerifyTopK).toBe(1);
  });

  it('re-ranks and re-filters admitted candidates after klend mutation before plan building', async () => {
    const filterCalls: Array<Array<Record<string, unknown>>> = [];
    mocks.filterCandidatesWithStats.mockImplementation((candidates) => {
      filterCalls.push(candidates as Array<Record<string, unknown>>);
      return {
        filtered: candidates.filter((candidate: Record<string, unknown>) => Number(candidate.healthRatio ?? 2) < 1),
        stats: {
          reasons: { evTooLow: 0, ttlTooHigh: 0, hazardTooLow: 0, missingHealth: 0, missingBorrow: 0 },
        },
      };
    });
    mocks.getKlendSdkVerifier.mockReturnValue({
      verify: vi.fn().mockResolvedValue({
        ok: true,
        healthRatioSdk: 0.97,
        healthRatioSdkRaw: 0.97,
      }),
    });
    const candidatesByKey = new Map([['k1', makeCandidate({ rankBucket: 'near-ready', forecast: { ttlMinutes: 5 } })]]);
    const result = await promoteWatchedCandidatesToQueue({ keys: ['k1'], candidatesByKey });

    expect(mocks.selectCandidates).toHaveBeenCalledTimes(2);
    expect(filterCalls).toHaveLength(2);
    expect(filterCalls[1][0]).toEqual(
      expect.objectContaining({
        healthRatio: 0.97,
        healthSource: 'klend-sdk',
        healthSourceUsed: 'klend-sdk',
        healthSourceVerified: 'klend-sdk',
      }),
    );
    expect(result.enqueued).toBe(1);
  });

  it('reports rejected reason counters for healthy and topK rejections', async () => {
    envState.SHADOW_PROMOTION_KLEND_VERIFY_TOPK = '1';
    mocks.getKlendSdkVerifier.mockReturnValue({
      verify: vi.fn().mockResolvedValue({
        ok: true,
        healthRatioSdk: 1.05,
        healthRatioSdkRaw: 1.05,
      }),
    });
    const candidatesByKey = new Map([
      ['k1', makeCandidate({ key: 'k1', obligationPubkey: 'k1', rankBucket: 'near-ready', forecast: { ttlMinutes: 5 } })],
      ['k2', makeCandidate({ key: 'k2', obligationPubkey: 'k2', rankBucket: 'near-ready', forecast: { ttlMinutes: 5 } })],
    ]);
    await promoteWatchedCandidatesToQueue({ keys: ['k1'], candidatesByKey });
    const result = await promoteWatchedCandidatesToQueue({ keys: ['k1', 'k2'], candidatesByKey });

    expect(result.rejectedReasons.shadowPromotionKlendHealthy).toBe(1);
    expect(result.rejectedReasons.shadowPromotionNotInKlendVerifyTopK).toBe(1);
  });

  it('does not re-verify same healthy candidate while cooldown is active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T00:00:00.000Z'));
    envState.SHADOW_PROMOTION_KLEND_HEALTHY_COOLDOWN_MS = '15000';
    const verify = vi.fn().mockResolvedValue({
      ok: true,
      healthRatioSdk: 1.02,
      healthRatioSdkRaw: 1.02,
    });
    mocks.getKlendSdkVerifier.mockReturnValue({ verify });
    const candidatesByKey = new Map([
      ['k-cooldown', makeCandidate({
        key: 'k-cooldown',
        obligationPubkey: 'k-cooldown',
        rankBucket: 'near-ready',
        forecast: { ttlMinutes: 5 },
        createdAtMs: 1111,
      })],
    ]);

    const first = await promoteWatchedCandidatesToQueue({ keys: ['k-cooldown'], candidatesByKey });
    const second = await promoteWatchedCandidatesToQueue({ keys: ['k-cooldown'], candidatesByKey });

    expect(verify).toHaveBeenCalledTimes(1);
    expect(first.rejectedReasons.shadowPromotionKlendHealthy).toBe(1);
    expect(second.skippedByHealthyCooldown).toBe(1);
    expect(second.rejectedReasons.shadowPromotionHealthyCooldown).toBe(1);
    vi.useRealTimers();
  });
});
