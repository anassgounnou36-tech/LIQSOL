import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  shadowTargets: {
    queueTargets: [] as Array<{ key: string; obligationPubkey: string; assets?: string[] }>,
    shadowOnlyTargets: [] as Array<{ key: string; obligationPubkey: string; assets?: string[] }>,
    allTargets: [] as Array<{ key: string; obligationPubkey: string; assets?: string[] }>,
  },
  accountListenerConfigs: [] as Array<{ accountPubkeys: string[] }>,
  accountUpdateTargets: vi.fn(),
  updaterRefreshMapping: vi.fn(),
  updaterBootstrapWatch: vi.fn(),
  runDryExecutor: vi.fn(),
}));

vi.mock('../scheduler/config/startupSchedulerConfig.js', () => ({
  loadStartupSchedulerConfig: vi.fn(() => ({})),
}));

vi.mock('../config/env.js', () => ({
  loadEnv: vi.fn(() => ({
    YELLOWSTONE_GRPC_URL: 'http://grpc',
    YELLOWSTONE_X_TOKEN: 'token',
    KAMINO_MARKET_PUBKEY: '11111111111111111111111111111111',
    KAMINO_KLEND_PROGRAM_ID: '11111111111111111111111111111111',
  })),
}));

vi.mock('../scheduler/txScheduler.js', () => ({
  refreshQueue: vi.fn(() => []),
  loadQueue: vi.fn(() => []),
}));

vi.mock('../monitoring/shadowWatchlist.js', () => ({
  loadShadowWatchTargets: vi.fn(() => mockState.shadowTargets),
}));

vi.mock('../execute/executor.js', () => ({
  runDryExecutor: mockState.runDryExecutor,
}));

vi.mock('../monitoring/yellowstoneAccountListener.js', () => ({
  YellowstoneAccountListener: class {
    constructor(cfg: { accountPubkeys: string[] }) {
      mockState.accountListenerConfigs.push(cfg);
    }
    on() {}
    async start() {}
    updateTargets(keys: string[]) {
      mockState.accountUpdateTargets(keys);
    }
  },
}));

vi.mock('../monitoring/yellowstonePriceListener.js', () => ({
  YellowstonePriceListener: class {
    on() {}
    async start() {}
  },
}));

vi.mock('../monitoring/realtimeForecastUpdater.js', () => ({
  RealtimeForecastUpdater: class {
    async refreshMappingFromWatchTargets(targets: Array<{ key: string }>) {
      mockState.updaterRefreshMapping(targets);
    }
    async bootstrapWatchObligations(keys: string[]) {
      mockState.updaterBootstrapWatch(keys);
    }
    handleObligationAccountUpdate() {}
    handleOracleAccountUpdate() {}
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

describe('botStartupScheduler shadow watch integration', () => {
  const originalSetInterval = global.setInterval;

  beforeEach(() => {
    mockState.shadowTargets = { queueTargets: [], shadowOnlyTargets: [], allTargets: [] };
    mockState.accountListenerConfigs = [];
    mockState.accountUpdateTargets.mockReset();
    mockState.updaterRefreshMapping.mockReset();
    mockState.updaterBootstrapWatch.mockReset();
    mockState.runDryExecutor.mockReset();
    mockState.runDryExecutor.mockResolvedValue({ status: 'ok' });
    vi.spyOn(global, 'setInterval').mockImplementation((() => 1) as any);
    process.env.SCHEDULER_ENABLE_EXECUTOR = 'false';
    process.env.SCHEDULER_ENABLE_AUDIT = 'false';
  });

  afterEach(() => {
    global.setInterval = originalSetInterval;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('loads realtime init targets from queue + candidates when shadow watch is enabled', async () => {
    mockState.shadowTargets = {
      queueTargets: [{ key: 'q1', obligationPubkey: 'q1', assets: ['SOL'] }],
      shadowOnlyTargets: [{ key: 's1', obligationPubkey: 's1', assets: ['USDC'] }],
      allTargets: [
        { key: 'q1', obligationPubkey: 'q1', assets: ['SOL'] },
        { key: 's1', obligationPubkey: 's1', assets: ['USDC'] },
      ],
    };

    const { startBotStartupScheduler } = await import('../scheduler/botStartupScheduler.js');
    await startBotStartupScheduler();

    expect(mockState.accountListenerConfigs[0]?.accountPubkeys).toEqual(['q1', 's1']);
    expect(mockState.updaterRefreshMapping).toHaveBeenCalledWith(
      expect.arrayContaining([{ key: 'q1', obligationPubkey: 'q1', assets: ['SOL'] }]),
    );
  });

  it('keeps watch subscriptions non-empty when queue is empty but candidates exist', async () => {
    mockState.shadowTargets = {
      queueTargets: [],
      shadowOnlyTargets: [{ key: 's-only', obligationPubkey: 's-only', assets: ['USDC'] }],
      allTargets: [{ key: 's-only', obligationPubkey: 's-only', assets: ['USDC'] }],
    };

    const { startBotStartupScheduler, reloadRealtimeWatchTargets } = await import('../scheduler/botStartupScheduler.js');
    await startBotStartupScheduler();
    await reloadRealtimeWatchTargets();

    expect(mockState.accountListenerConfigs[0]?.accountPubkeys).toEqual(['s-only']);
    expect(mockState.accountUpdateTargets).toHaveBeenCalledWith(['s-only']);
    expect(mockState.updaterBootstrapWatch).toHaveBeenCalledWith(['s-only']);
  });
});
