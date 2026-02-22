import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { runInitialPipeline } from '../pipeline/runInitialPipeline.js';
import * as snapshotModule from '../commands/snapshotObligations.js';
import * as buildCandidatesModule from '../pipeline/buildCandidates.js';
import * as buildQueueModule from '../pipeline/buildQueue.js';

const { existsSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  default: {
    existsSync: existsSyncMock,
  },
}));

vi.mock('../commands/snapshotObligations.js', () => ({
  snapshotObligationPubkeysToFile: vi.fn(),
}));

vi.mock('../pipeline/buildCandidates.js', () => ({
  buildCandidates: vi.fn(),
}));

vi.mock('../pipeline/buildQueue.js', () => ({
  buildQueue: vi.fn(),
}));

describe('runInitialPipeline', () => {
  const marketPubkey = new PublicKey('ByYiM4A4wW8fQ5h6pw4QmMkPY7Xx8SFEY7XhMThjX7kY');
  const programId = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
  const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
  });

  afterAll(() => {
    infoSpy.mockRestore();
  });

  it('creates obligations snapshot when missing, then builds candidates and queue in replace mode', async () => {
    existsSyncMock.mockReturnValue(false);

    await runInitialPipeline({
      marketPubkey,
      programId,
      allowlistMints: ['So11111111111111111111111111111111111111112'],
      topN: 25,
      nearThreshold: 1.01,
      flashloanMint: 'USDC',
    });

    expect(snapshotModule.snapshotObligationPubkeysToFile).toHaveBeenCalledWith({
      marketPubkey,
      programId,
      outputPath: 'data/obligations.jsonl',
    });
    expect(buildCandidatesModule.buildCandidates).toHaveBeenCalledWith({
      marketPubkey,
      programId,
      allowlistMints: ['So11111111111111111111111111111111111111112'],
      topN: 25,
      nearThreshold: 1.01,
    });
    expect(buildQueueModule.buildQueue).toHaveBeenCalledWith({
      flashloanMint: 'USDC',
      mode: 'replace',
    });
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('skips snapshot creation when obligations snapshot already exists', async () => {
    await runInitialPipeline({
      marketPubkey,
      programId,
      topN: 50,
      nearThreshold: 1.02,
      flashloanMint: 'SOL',
    });

    expect(snapshotModule.snapshotObligationPubkeysToFile).not.toHaveBeenCalled();
    expect(buildCandidatesModule.buildCandidates).toHaveBeenCalledTimes(1);
    expect(buildQueueModule.buildQueue).toHaveBeenCalledWith({
      flashloanMint: 'SOL',
      mode: 'replace',
    });
    expect(infoSpy).toHaveBeenCalledWith(
      'INFO: Using existing obligations snapshot at data/obligations.jsonl. If you see refresh_obligation 6006 errors, regenerate snapshot via npm run snapshot:obligations.'
    );
  });
});
