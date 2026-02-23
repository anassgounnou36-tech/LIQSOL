import fs from 'fs';
import { PublicKey } from '@solana/web3.js';
import { snapshotObligationPubkeysToFile } from '../commands/snapshotObligations.js';
import { buildCandidates } from './buildCandidates.js';
import { buildQueue } from './buildQueue.js';

export async function runInitialPipeline(opts: {
  marketPubkey: PublicKey;
  programId: PublicKey;
  execAllowlistMints?: string[];
  topN: number;
  nearThreshold: number;
  flashloanMint: 'USDC' | 'SOL';
}): Promise<void> {
  const obligationsPath = 'data/obligations.jsonl';

  if (!fs.existsSync(obligationsPath)) {
    await snapshotObligationPubkeysToFile({
      marketPubkey: opts.marketPubkey,
      programId: opts.programId,
      outputPath: obligationsPath,
    });
  }

  await buildCandidates({
    marketPubkey: opts.marketPubkey,
    programId: opts.programId,
    execAllowlistMints: opts.execAllowlistMints,
    topN: opts.topN,
    nearThreshold: opts.nearThreshold,
  });

  await buildQueue({
    flashloanMint: opts.flashloanMint,
    mode: 'replace',
  });
}
