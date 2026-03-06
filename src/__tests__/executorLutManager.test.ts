import { describe, expect, it, vi } from 'vitest';
import { Keypair, TransactionInstruction } from '@solana/web3.js';
import { collectLutCandidateAddresses, extendExecutorLut } from '../solana/executorLutManager.js';

describe('collectLutCandidateAddresses', () => {
  it('includes program ids, excludes payer/signers, and dedupes in stable order', () => {
    const payer = Keypair.generate().publicKey;
    const signer = Keypair.generate().publicKey;
    const shared = Keypair.generate().publicKey;
    const nonSignerA = Keypair.generate().publicKey;
    const nonSignerB = Keypair.generate().publicKey;
    const programA = Keypair.generate().publicKey;
    const programB = Keypair.generate().publicKey;

    const ixs: TransactionInstruction[] = [
      new TransactionInstruction({
        programId: programA,
        keys: [
          { pubkey: payer, isSigner: false, isWritable: false },
          { pubkey: signer, isSigner: true, isWritable: false },
          { pubkey: shared, isSigner: false, isWritable: false },
          { pubkey: nonSignerA, isSigner: false, isWritable: true },
        ],
        data: Buffer.alloc(0),
      }),
      new TransactionInstruction({
        programId: programA, // duplicate program
        keys: [
          { pubkey: shared, isSigner: false, isWritable: false }, // duplicate key
          { pubkey: nonSignerB, isSigner: false, isWritable: true },
          { pubkey: signer, isSigner: true, isWritable: false },
        ],
        data: Buffer.alloc(0),
      }),
      new TransactionInstruction({
        programId: programB,
        keys: [{ pubkey: nonSignerA, isSigner: false, isWritable: false }],
        data: Buffer.alloc(0),
      }),
    ];

    const result = collectLutCandidateAddresses(ixs, payer).map((k) => k.toBase58());
    expect(result).toEqual([
      programA.toBase58(),
      shared.toBase58(),
      nonSignerA.toBase58(),
      nonSignerB.toBase58(),
      programB.toBase58(),
    ]);
    expect(result).not.toContain(payer.toBase58());
    expect(result).not.toContain(signer.toBase58());
  });

  it('skips extension when LUT is already at max capacity', async () => {
    const signer = Keypair.generate();
    const lut = {
      key: Keypair.generate().publicKey,
      state: {
        addresses: Array.from({ length: 256 }, () => Keypair.generate().publicKey),
      },
    } as any;
    const connection = {
      getLatestBlockhash: vi.fn(),
      sendTransaction: vi.fn(),
      getAddressLookupTable: vi.fn(),
    } as any;

    const updated = await extendExecutorLut(connection, signer, lut, [Keypair.generate().publicKey]);
    expect(updated).toBe(lut);
    expect(connection.sendTransaction).not.toHaveBeenCalled();
  });
});
