import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeStream extends EventEmitter {
  write() {}
  destroy() {
    this.emit('close');
  }
}

const mockState = vi.hoisted(() => ({
  streams: [] as FakeStream[],
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../yellowstone/client.js', () => ({
  createYellowstoneClient: vi.fn(async () => ({
    subscribe: async () => {
      const stream = new FakeStream();
      mockState.streams.push(stream);
      return stream;
    },
  })),
}));

vi.mock('../observability/logger.js', () => ({
  logger: {
    info: mockState.loggerInfo,
    error: mockState.loggerError,
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Yellowstone listener restart lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.streams = [];
    mockState.loggerInfo.mockReset();
    mockState.loggerError.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('updateTargets() planned restart does not trigger failure reconnect path', async () => {
    const { YellowstoneAccountListener } = await import('../monitoring/yellowstoneAccountListener.js');
    const listener = new YellowstoneAccountListener({
      grpcUrl: 'grpc://local',
      accountPubkeys: ['a1'],
      reconnectBaseMs: 100,
      reconnectMaxMs: 500,
      resubscribeSettleMs: 10,
    });
    await listener.start();
    listener.updateTargets(['a2']);
    await vi.advanceTimersByTimeAsync(20);
    const reconnectLogs = mockState.loggerInfo.mock.calls.filter(call => call[1] === 'Yellowstone listener reconnect scheduled');
    expect(reconnectLogs).toHaveLength(0);
  });

  it('actual stream close does trigger reconnect path', async () => {
    const { YellowstoneAccountListener } = await import('../monitoring/yellowstoneAccountListener.js');
    const listener = new YellowstoneAccountListener({
      grpcUrl: 'grpc://local',
      accountPubkeys: ['a1'],
      reconnectBaseMs: 100,
      reconnectMaxMs: 500,
    });
    await listener.start();
    mockState.streams[0].emit('close');
    const reconnectLogs = mockState.loggerInfo.mock.calls.filter(call => call[1] === 'Yellowstone listener reconnect scheduled');
    expect(reconnectLogs.length).toBeGreaterThanOrEqual(1);
    expect(reconnectLogs[0][0]).toMatchObject({ delayMs: 100 });
  });

  it('successful first message resets reconnect backoff', async () => {
    const { YellowstoneAccountListener } = await import('../monitoring/yellowstoneAccountListener.js');
    const listener = new YellowstoneAccountListener({
      grpcUrl: 'grpc://local',
      accountPubkeys: ['11111111111111111111111111111111'],
      reconnectBaseMs: 100,
      reconnectMaxMs: 500,
    });
    await listener.start();
    mockState.streams[0].emit('close');
    await vi.advanceTimersByTimeAsync(100);
    mockState.streams[1].emit('data', {
      account: {
        slot: 1,
        writeVersion: 1,
        account: {
          pubkey: Buffer.alloc(32, 1),
          owner: Buffer.alloc(32, 1),
          data: Buffer.from([1, 2, 3]),
          writeVersion: 1,
        },
      },
    });
    mockState.streams[1].emit('close');
    const reconnectLogs = mockState.loggerInfo.mock.calls.filter(call => call[1] === 'Yellowstone listener reconnect scheduled');
    expect(reconnectLogs[0][0]).toMatchObject({ delayMs: 100 });
    expect(reconnectLogs[1][0]).toMatchObject({ delayMs: 100 });
  });

  it('planned restart does not log channel-close as error', async () => {
    const { YellowstoneAccountListener } = await import('../monitoring/yellowstoneAccountListener.js');
    const listener = new YellowstoneAccountListener({
      grpcUrl: 'grpc://local',
      accountPubkeys: ['a1'],
      reconnectBaseMs: 100,
      reconnectMaxMs: 500,
      resubscribeSettleMs: 10,
    });
    await listener.start();
    listener.updateTargets(['a2']);
    mockState.streams[0].emit('close');
    await vi.advanceTimersByTimeAsync(20);
    expect(mockState.loggerError).not.toHaveBeenCalled();
  });

  it('price listener planned restart does not use failure reconnect path', async () => {
    const { YellowstonePriceListener } = await import('../monitoring/yellowstonePriceListener.js');
    const listener = new YellowstonePriceListener({
      grpcUrl: 'grpc://local',
      oraclePubkeys: ['o1'],
      reconnectBaseMs: 100,
      reconnectMaxMs: 500,
      resubscribeSettleMs: 10,
    });
    await listener.start();
    listener.updateTargets(['o2']);
    await vi.advanceTimersByTimeAsync(20);
    const reconnectLogs = mockState.loggerInfo.mock.calls.filter(call => call[1] === 'Yellowstone listener reconnect scheduled');
    expect(reconnectLogs).toHaveLength(0);
    expect(mockState.loggerError).not.toHaveBeenCalled();
  });
});
