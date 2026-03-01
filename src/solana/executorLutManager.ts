import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import { buildVersionedTx } from '../execute/versionedTx.js';
import { confirmSignatureByPolling } from './confirmPolling.js';

const EXTEND_BATCH_SIZE = 20;

export function collectLutCandidateAddresses(
  ixs: TransactionInstruction[],
  payer: PublicKey
): PublicKey[] {
  const seen = new Set<string>();
  const ordered: PublicKey[] = [];
  const payer58 = payer.toBase58();

  const addIfEligible = (key: PublicKey) => {
    const key58 = key.toBase58();
    if (key58 === payer58 || seen.has(key58)) return;
    seen.add(key58);
    ordered.push(key);
  };

  for (const ix of ixs) {
    addIfEligible(ix.programId);
    for (const key of ix.keys) {
      if (key.isSigner) continue;
      addIfEligible(key.pubkey);
    }
  }

  return ordered;
}

export async function loadExecutorLut(
  connection: Connection,
  lutAddress: PublicKey
): Promise<AddressLookupTableAccount | undefined> {
  const response = await connection.getAddressLookupTable(lutAddress);
  return response.value ?? undefined;
}

export async function createExecutorLut(
  connection: Connection,
  signer: Keypair
): Promise<PublicKey> {
  const recentSlot = await connection.getSlot('finalized');
  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    authority: signer.publicKey,
    payer: signer.publicKey,
    recentSlot,
  });
  const bh = await connection.getLatestBlockhash();
  const tx = await buildVersionedTx({
    payer: signer.publicKey,
    blockhash: bh.blockhash,
    instructions: [createIx],
    signer,
  });
  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 2,
  });
  const confirmation = await confirmSignatureByPolling(connection, signature, {
    commitment: 'confirmed',
  });
  if (!confirmation.success) {
    throw new Error(`[LUT] failed to create executor LUT: ${signature}`);
  }
  return lutAddress;
}

export async function extendExecutorLut(
  connection: Connection,
  signer: Keypair,
  lut: AddressLookupTableAccount,
  addressesToAdd: PublicKey[]
): Promise<AddressLookupTableAccount> {
  const current = new Set(lut.state.addresses.map((a) => a.toBase58()));
  const missing = addressesToAdd.filter((a) => !current.has(a.toBase58()));
  if (missing.length === 0) return lut;

  let extendTxCount = 0;
  for (let i = 0; i < missing.length; i += EXTEND_BATCH_SIZE) {
    const batch = missing.slice(i, i + EXTEND_BATCH_SIZE);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: signer.publicKey,
      authority: signer.publicKey,
      lookupTable: lut.key,
      addresses: batch,
    });
    const bh = await connection.getLatestBlockhash();
    const tx = await buildVersionedTx({
      payer: signer.publicKey,
      blockhash: bh.blockhash,
      instructions: [extendIx],
      signer,
    });
    const signature = await connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 2,
    });
    const confirmation = await confirmSignatureByPolling(connection, signature, {
      commitment: 'confirmed',
    });
    if (!confirmation.success) {
      throw new Error(`[LUT] failed to extend executor LUT: ${signature}`);
    }
    extendTxCount++;
  }

  const updated = await loadExecutorLut(connection, lut.key);
  if (!updated) {
    throw new Error(`[LUT] executor LUT missing after extension: ${lut.key.toBase58()}`);
  }
  console.log(`[LUT] extension complete: added=${missing.length}, extendTxs=${extendTxCount}, size=${updated.state.addresses.length}`);
  return updated;
}
