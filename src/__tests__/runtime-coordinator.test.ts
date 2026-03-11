import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const mockState = vi.hoisted(() => ({
  watchTargets: {
    queueTargets: [] as Array<{ key: string; obligationPubkey: string }>,
    shadowOnlyTargets: [] as Array<{ key: string; obligationPubkey: string }>,
    allTargets: [] as Array<{ key: string; obligationPubkey: string }>,
  },
  pipelineRuns: 0,
  executorCalls: [] as Array<{ queueEmptyLogIntervalMs?: number }>,
  updaterRefreshes: 0,
  updaterBootstraps: 0,
  accountStarts: 0,
  accountStops: 0,
  accountTargetUpdates: [] as string[][],
}));

vi.mock('../config/env.js', () => ({
  loadEnv: vi.fn(() => ({
    YELLOWSTONE_GRPC_URL: 'http://grpc',
    YELLOWSTONE_X_TOKEN: 'token',
    CAND_TOP: '50',
    CAND_NEAR: '1.02',
  })),
}));

vi.mock('../scheduler/config/startupSchedulerConfig.js', () => ({
  loadStartupSchedulerConfig: vi.fn(() => ({})),
}));

vi.mock('../live/runtimeConfig.js', () => ({
  loadLiveRuntimeConfig: vi.fn(() => ({
    yellowstoneReconnectBaseMs: 1000,
    yellowstoneReconnectMaxMs: 30000,
    yellowstoneResubscribeSettleMs: 250,
  })),
}));

vi.mock('../pipeline/runInitialPipeline.js', () => ({
  runInitialPipeline: vi.fn(async () => {
    mockState.pipelineRuns++;
  }),
}));

vi.mock('../monitoring/shadowWatchlist.js', () => ({
  loadShadowWatchTargets: vi.fn(() => mockState.watchTargets),
}));

vi.mock('../scheduler/txScheduler.js', () => ({
  refreshQueue: vi.fn(() => []),
  loadQueue: vi.fn(() => []),
}));

vi.mock('../execute/executor.js', () => ({
  runDryExecutor: vi.fn(async (opts: { queueEmptyLogIntervalMs?: number }) => {
    mockState.executorCalls.push(opts);
    return { status: 'no-plans' };
  }),
}));

vi.mock('../monitoring/realtimeForecastUpdater.js', () => ({
  RealtimeForecastUpdater: class {
    async refreshMappingFromWatchTargets() {
      mockState.updaterRefreshes++;
    }
    async bootstrapWatchObligations() {
      mockState.updaterBootstraps++;
    }
    handleObligationAccountUpdate() {}
    handleOracleAccountUpdate() {}
  },
}));

vi.mock('../monitoring/yellowstoneAccountListener.js', () => ({
  YellowstoneAccountListener: class {
    on() {}
    async start() {
      mockState.accountStarts++;
    }
    async stop() {
      mockState.accountStops++;
    }
    updateTargets(keys: string[]) {
      mockState.accountTargetUpdates.push(keys);
    }
  },
}));

vi.mock('../monitoring/yellowstonePriceListener.js', () => ({
  YellowstonePriceListener: class {
    on() {}
    async start() {}
    async stop() {}
  },
}));

vi.mock('../solana/connection.js', () => ({
  getConnection: vi.fn(() => ({})),
}));

vi.mock('../cache/reserveCache.js', () => ({
  loadReserves: vi.fn(async () => ({ byMint: new Map(), byReserve: new Map() })),
}));

vi.mock('../cache/oracleCache.js', () => ({
  loadOracles: vi.fn(async () => new Map()),
}));

describe('RuntimeCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.watchTargets = {
      queueTargets: [{ key: 'q1', obligationPubkey: 'q1' }],
      shadowOnlyTargets: [{ key: 's1', obligationPubkey: 's1' }],
      allTargets: [
        { key: 'q1', obligationPubkey: 'q1' },
        { key: 's1', obligationPubkey: 's1' },
      ],
    };
    mockState.pipelineRuns = 0;
    mockState.executorCalls = [];
    mockState.updaterRefreshes = 0;
    mockState.updaterBootstraps = 0;
    mockState.accountStarts = 0;
    mockState.accountStops = 0;
    mockState.accountTargetUpdates = [];
    process.env.SCHEDULER_ENABLE_EXECUTOR = 'true';
    process.env.SCHEDULER_ENABLE_AUDIT = 'false';
    process.env.SCHEDULER_ENABLE_REFRESH = 'false';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('coordinator start initializes realtime only once', async () => {
    const { RuntimeCoordinator } = await import('../live/runtimeCoordinator.js');
    const coordinator = new RuntimeCoordinator(
      {
        marketPubkey: PublicKey.unique(),
        programId: PublicKey.unique(),
      },
      {
        rebuildIntervalMs: 120000,
        heartbeatIntervalMs: 60000,
        tickDebounceMs: 200,
        queueEmptyLogIntervalMs: 30000,
        promotionSummaryLogIntervalMs: 10000,
        realtimeEnabled: true,
      },
    );

    await coordinator.start({ broadcast: false });
    await coordinator.start({ broadcast: false });
    expect(mockState.accountStarts).toBe(1);
  });

  it('periodic rebuild delegates to pipeline and watch reload', async () => {
    const { RuntimeCoordinator } = await import('../live/runtimeCoordinator.js');
    const coordinator = new RuntimeCoordinator(
      {
        marketPubkey: PublicKey.unique(),
        programId: PublicKey.unique(),
      },
      {
        rebuildIntervalMs: 120000,
        heartbeatIntervalMs: 60000,
        tickDebounceMs: 200,
        queueEmptyLogIntervalMs: 30000,
        promotionSummaryLogIntervalMs: 10000,
        realtimeEnabled: true,
      },
    );
    await coordinator.start({ broadcast: false });
    mockState.watchTargets = {
      queueTargets: [{ key: 'q2', obligationPubkey: 'q2' }],
      shadowOnlyTargets: [],
      allTargets: [{ key: 'q2', obligationPubkey: 'q2' }],
    };
    await coordinator.runPeriodicRebuild('test-rebuild');
    expect(mockState.pipelineRuns).toBe(1);
    expect(mockState.accountTargetUpdates).toContainEqual(['q2']);
  });

  it('reload with unchanged watch fingerprints is treated as no-op', async () => {
    const { RuntimeCoordinator } = await import('../live/runtimeCoordinator.js');
    const coordinator = new RuntimeCoordinator(
      {
        marketPubkey: PublicKey.unique(),
        programId: PublicKey.unique(),
      },
      {
        rebuildIntervalMs: 120000,
        heartbeatIntervalMs: 60000,
        tickDebounceMs: 200,
        queueEmptyLogIntervalMs: 30000,
        promotionSummaryLogIntervalMs: 10000,
        realtimeEnabled: true,
      },
    );
    await coordinator.start({ broadcast: false });
    await coordinator.reloadWatchTargets('same');
    expect(mockState.accountTargetUpdates).toHaveLength(0);
  });

  it('queue-empty logs are throttled by forwarding configured interval to executor', async () => {
    const { RuntimeCoordinator } = await import('../live/runtimeCoordinator.js');
    const coordinator = new RuntimeCoordinator(
      {
        marketPubkey: PublicKey.unique(),
        programId: PublicKey.unique(),
      },
      {
        rebuildIntervalMs: 120000,
        heartbeatIntervalMs: 200,
        tickDebounceMs: 5,
        queueEmptyLogIntervalMs: 32123,
        promotionSummaryLogIntervalMs: 10000,
        realtimeEnabled: false,
      },
    );
    await coordinator.start({ broadcast: false });
    await vi.advanceTimersByTimeAsync(250);
    expect(mockState.executorCalls.length).toBeGreaterThanOrEqual(2);
    expect(mockState.executorCalls.every(call => call.queueEmptyLogIntervalMs === 32123)).toBe(true);
  });

  it('stop() clears timers/listeners cleanly', async () => {
    const { RuntimeCoordinator } = await import('../live/runtimeCoordinator.js');
    const coordinator = new RuntimeCoordinator(
      {
        marketPubkey: PublicKey.unique(),
        programId: PublicKey.unique(),
      },
      {
        rebuildIntervalMs: 120000,
        heartbeatIntervalMs: 200,
        tickDebounceMs: 10,
        queueEmptyLogIntervalMs: 30000,
        promotionSummaryLogIntervalMs: 10000,
        realtimeEnabled: true,
      },
    );
    await coordinator.start({ broadcast: false });
    await coordinator.stop();
    await vi.advanceTimersByTimeAsync(500);
    const callsAtStop = mockState.executorCalls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(mockState.accountStops).toBe(1);
    expect(mockState.executorCalls.length).toBe(callsAtStop);
  });

  it('promotion-summary logs are throttled by signature stability but emit on state change', async () => {
    const { buildShadowPromotionSummarySignature } = await import('../monitoring/shadowWatchPromotion.js');
    const stable = {
      considered: 1,
      ranked: 1,
      queueEligible: 1,
      verifiedByKlend: 1,
      admittedByKlend: 1,
      skippedByHealthyCooldown: 0,
      enqueued: 1,
      rejectedReasons: { a: 1 },
    };
    const changed = { ...stable, enqueued: 2 };
    expect(buildShadowPromotionSummarySignature(stable)).toBe(buildShadowPromotionSummarySignature(stable));
    expect(buildShadowPromotionSummarySignature(stable)).not.toBe(buildShadowPromotionSummarySignature(changed));
  });
});
