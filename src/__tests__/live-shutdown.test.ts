import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockState = vi.hoisted(() => ({
  runPeriodicRebuild: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  handlers: {} as Record<string, () => void>,
  exitCalls: 0,
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
  loadEnv: vi.fn(() => ({
    KAMINO_MARKET_PUBKEY: '11111111111111111111111111111111',
    KAMINO_KLEND_PROGRAM_ID: '11111111111111111111111111111111',
    RPC_PRIMARY: 'http://rpc',
    YELLOWSTONE_GRPC_URL: 'http://grpc',
  })),
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
    runPeriodicRebuild = mockState.runPeriodicRebuild;
    start = mockState.start;
    stop = mockState.stop;
  },
}));

vi.mock('../observability/logger.js', () => ({
  logger: {
    info: mockState.loggerInfo,
    error: mockState.loggerError,
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('startIntegratedLiveRunner shutdown handling', () => {
  let onceSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    mockState.handlers = {};
    mockState.exitCalls = 0;
    mockState.runPeriodicRebuild.mockReset().mockResolvedValue(undefined);
    mockState.start.mockReset().mockResolvedValue(undefined);
    mockState.stop.mockReset().mockResolvedValue(undefined);
    mockState.loggerInfo.mockReset();
    mockState.loggerError.mockReset();
    process.exitCode = undefined;

    onceSpy = vi
      .spyOn(process, 'once')
      .mockImplementation(((event: NodeJS.Signals, cb: () => void) => {
        mockState.handlers[event] = cb;
        return process;
      }) as any);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      mockState.exitCalls += 1;
      if (typeof code === 'number') {
        process.exitCode = code;
      }
      return undefined as never;
    }) as any);
  });

  afterEach(() => {
    onceSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = originalExitCode;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('signal handler calls and awaits coordinator.stop()', async () => {
    const stopDeferred = deferred<void>();
    mockState.stop.mockReturnValueOnce(stopDeferred.promise);

    const { startIntegratedLiveRunner } = await import('../bot/live.js');
    await startIntegratedLiveRunner({ broadcast: false });
    mockState.handlers.SIGINT();
    await Promise.resolve();

    expect(mockState.stop).toHaveBeenCalledTimes(1);
    expect(mockState.exitCalls).toBe(0);

    stopDeferred.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(process.exitCode).toBe(0);
    expect(mockState.exitCalls).toBe(1);
  });

  it('repeated signals do not trigger duplicate shutdown', async () => {
    const stopDeferred = deferred<void>();
    mockState.stop.mockReturnValueOnce(stopDeferred.promise);

    const { startIntegratedLiveRunner } = await import('../bot/live.js');
    await startIntegratedLiveRunner({ broadcast: false });
    mockState.handlers.SIGTERM();
    mockState.handlers.SIGINT();
    await Promise.resolve();

    expect(mockState.stop).toHaveBeenCalledTimes(1);
  });

  it('shutdown failure sets non-zero exit code', async () => {
    mockState.stop.mockRejectedValueOnce(new Error('stop failed'));

    const { startIntegratedLiveRunner } = await import('../bot/live.js');
    await startIntegratedLiveRunner({ broadcast: false });
    mockState.handlers.SIGINT();
    await Promise.resolve();
    await Promise.resolve();

    expect(process.exitCode).toBe(1);
    expect(mockState.exitCalls).toBe(1);
  });
});
