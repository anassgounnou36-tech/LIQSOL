import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  starts: 0,
  reloads: 0,
  startArgs: [] as Array<{ broadcast: boolean }>,
  reloadReasons: [] as string[],
}));

vi.mock('../config/env.js', () => ({
  loadEnv: vi.fn(() => ({
    KAMINO_MARKET_PUBKEY: '11111111111111111111111111111111',
    KAMINO_KLEND_PROGRAM_ID: '11111111111111111111111111111111',
  })),
}));

vi.mock('../scheduler/config/startupSchedulerConfig.js', () => ({
  loadStartupSchedulerConfig: vi.fn(() => ({})),
}));

vi.mock('../live/runtimeConfig.js', () => ({
  loadLiveRuntimeConfig: vi.fn(() => ({
    rebuildIntervalMs: 120000,
    heartbeatIntervalMs: 60000,
    tickDebounceMs: 200,
    queueEmptyLogIntervalMs: 30000,
    promotionSummaryLogIntervalMs: 10000,
    realtimeEnabled: true,
    yellowstoneReconnectBaseMs: 1000,
    yellowstoneReconnectMaxMs: 30000,
    yellowstoneResubscribeSettleMs: 250,
  })),
}));

vi.mock('../live/runtimeCoordinator.js', () => ({
  RuntimeCoordinator: class {
    async start(args: { broadcast: boolean }) {
      mockState.starts++;
      mockState.startArgs.push(args);
    }
    async reloadWatchTargets(reason: string) {
      mockState.reloads++;
      mockState.reloadReasons.push(reason);
    }
  },
}));

describe('botStartupScheduler compatibility wrapper', () => {
  beforeEach(() => {
    mockState.starts = 0;
    mockState.reloads = 0;
    mockState.startArgs = [];
    mockState.reloadReasons = [];
    process.env.LIQSOL_BROADCAST = 'false';
    process.env.EXECUTOR_BROADCAST = 'false';
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('starts runtime coordinator through compatibility wrapper', async () => {
    const { startBotStartupScheduler } = await import('../scheduler/botStartupScheduler.js');
    await startBotStartupScheduler();
    expect(mockState.starts).toBe(1);
    expect(mockState.startArgs[0]).toEqual({ broadcast: false });
  });

  it('reloadRealtimeWatchTargets delegates to coordinator reload', async () => {
    const { startBotStartupScheduler, reloadRealtimeWatchTargets } = await import('../scheduler/botStartupScheduler.js');
    await startBotStartupScheduler();
    await reloadRealtimeWatchTargets();
    expect(mockState.reloads).toBe(1);
    expect(mockState.reloadReasons[0]).toBe('manual-reload');
  });
});
