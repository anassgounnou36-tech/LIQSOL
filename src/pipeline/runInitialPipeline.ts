import fs from 'fs';
import { PublicKey } from '@solana/web3.js';
import { snapshotObligationPubkeysToFile } from '../commands/snapshotObligations.js';
import { buildCandidates } from './buildCandidates.js';
import { buildQueue } from './buildQueue.js';

export async function runInitialPipeline(opts: {
  marketPubkey: PublicKey;
  programId: PublicKey;
  allowlistMints?: string[];
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
  } else {
    console.info(
      'INFO: Using existing obligations snapshot at data/obligations.jsonl. If you see refresh_obligation 6006 errors, regenerate snapshot via npm run snapshot:obligations.'
    );
  }

  await buildCandidates({
    marketPubkey: opts.marketPubkey,
    programId: opts.programId,
    allowlistMints: opts.allowlistMints,
    topN: opts.topN,
    nearThreshold: opts.nearThreshold,
  });

  await buildQueue({
    flashloanMint: opts.flashloanMint,
    mode: 'replace',
  });
}
