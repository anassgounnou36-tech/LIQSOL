import { describe, it, expect } from 'vitest';
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { buildVersionedTx } from '../src/execute/versionedTx.js';
import { sendWithRebuildRetry } from '../src/execute/broadcastRetry.js';

function dummyIx(from: PublicKey): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: from,
    toPubkey: Keypair.generate().publicKey,
    lamports: 1,
  });
}

describe('Phase 3 versioned tx + rebuild retry', () => {
  it('buildVersionedTx compiles v0 when LUTs are provided', async () => {
    const signer = Keypair.generate();
    const lookup = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: {
        deactivationSlot: BigInt(0),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses: [Keypair.generate().publicKey],
      },
    });

    const tx = await buildVersionedTx({
      payer: signer.publicKey,
      blockhash: '11111111111111111111111111111111',
      instructions: [dummyIx(signer.publicKey)],
      lookupTables: [lookup],
      signer,
    });

    expect((tx.message as any).version).toBe(0);
  });

  it('sendWithRebuildRetry rebuilds with bumped CU limit after compute failure', async () => {
    const signer = Keypair.generate();
    const seen: Array<{ cuLimit: number; cuPrice: number }> = [];
    let sendCount = 0;

    const connection = {
      async getLatestBlockhash() {
        return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 };
      },
      async sendTransaction() {
        sendCount += 1;
        if (sendCount === 1) {
          throw new Error('compute exceeded');
        }
        return 'sig-success';
      },
      async getSignatureStatuses() {
        return {
          context: { slot: 1 },
          value: [{ confirmationStatus: 'confirmed', confirmations: 1, err: null, slot: 1 }],
        };
      },
      async getTransaction() {
        return null;
      },
    } as any;

    const attempts = await sendWithRebuildRetry(
      connection,
      signer,
      async ({ blockhash, cuLimit, cuPrice }) => {
        seen.push({ cuLimit, cuPrice });
        return buildVersionedTx({
          payer: signer.publicKey,
          blockhash,
          instructions: [dummyIx(signer.publicKey)],
          signer,
        });
      },
      {
        maxAttempts: 2,
        cuLimit: 100_000,
        cuPrice: 0,
        cuLimitBumpFactor: 1.5,
        cuPriceBumpMicrolamports: 1000,
      }
    );

    expect(attempts.length).toBe(2);
    expect(attempts[1]?.success).toBe(true);
    expect(seen[0]?.cuLimit).toBe(100_000);
    expect(seen[1]?.cuLimit).toBe(150_000);
  });
});
