import { describe, it, expect } from 'vitest';
import { Keypair, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { buildVersionedTx } from '../src/execute/versionedTx.js';
import { MAX_RAW_TX_BYTES, getRawTxBytes, isTxTooLarge } from '../src/execute/txSize.js';

function transferIx(from: Keypair): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: from.publicKey,
    toPubkey: Keypair.generate().publicKey,
    lamports: 1,
  });
}

describe('tx size helper', () => {
  it('reports serialized transaction byte size', async () => {
    const signer = Keypair.generate();
    const tx = await buildVersionedTx({
      payer: signer.publicKey,
      blockhash: '11111111111111111111111111111111',
      instructions: [transferIx(signer)],
      signer,
    });

    expect(getRawTxBytes(tx)).toBeGreaterThan(0);
  });

  it('flags oversized transactions using MAX_RAW_TX_BYTES', async () => {
    const signer = Keypair.generate();
    const ixs = Array.from({ length: 40 }, () => transferIx(signer));
    const tx = await buildVersionedTx({
      payer: signer.publicKey,
      blockhash: '11111111111111111111111111111111',
      instructions: ixs,
      signer,
    });

    const check = isTxTooLarge(tx);
    expect(check.raw).toBe(getRawTxBytes(tx));
    expect(check.tooLarge).toBe(check.raw > MAX_RAW_TX_BYTES);
  });
});
