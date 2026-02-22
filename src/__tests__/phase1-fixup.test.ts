import { describe, it, expect, vi, afterEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const getProgramAccountsMock = vi.fn();
const mkdirSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const renameSyncMock = vi.fn();

vi.mock('../solana/connection.js', () => ({
  getConnection: () => ({
    getProgramAccounts: getProgramAccountsMock,
  }),
}));

vi.mock('../config/env.js', () => ({
  loadReadonlyEnv: () => ({ RPC_PRIMARY: 'http://localhost:8899' }),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: mkdirSyncMock,
    writeFileSync: writeFileSyncMock,
    renameSync: renameSyncMock,
  };
});

describe('Phase 1 fixup guards and market filter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not auto-run live and snapshot CLIs when imported', async () => {
    const originalArgv1 = process.argv[1];
    process.argv[1] = '/tmp/not-direct-run.ts';
    try {
      vi.resetModules();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      await import('../bot/live.ts');
      await import('../commands/snapshotObligations.ts');

      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  it('applies market memcmp filter when snapshotting obligations', async () => {
    vi.resetModules();
    const marketPubkey = new PublicKey('ByYiM4A4wW8fQ5h6pw4QmMkPY7Xx8SFEY7XhMThjX7kY');
    const programId = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

    const accounts = Array.from({ length: 50 }, (_, i) => ({
      pubkey: new PublicKey(Uint8Array.from(Array.from({ length: 32 }, (__, j) => (j === 31 ? i + 1 : 0)))),
    }));
    getProgramAccountsMock.mockResolvedValue(accounts);

    const { snapshotObligationPubkeysToFile } = await import('../commands/snapshotObligations.ts');

    await snapshotObligationPubkeysToFile({
      marketPubkey,
      programId,
      outputPath: 'data/obligations.jsonl',
    });

    expect(getProgramAccountsMock).toHaveBeenCalledTimes(1);
    const options = getProgramAccountsMock.mock.calls[0][1];
    expect(options.filters).toHaveLength(2);
    expect(options.filters[1]).toEqual({
      memcmp: {
        offset: 32,
        bytes: marketPubkey.toBase58(),
      },
    });
  });
});
