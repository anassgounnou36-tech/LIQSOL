import { VersionedTransaction } from '@solana/web3.js';

export const MAX_RAW_TX_BYTES = 1232;

export function getRawTxBytes(tx: VersionedTransaction): number {
  try {
    return tx.serialize().length;
  } catch {
    return MAX_RAW_TX_BYTES + 1;
  }
}

export function isTxTooLarge(tx: VersionedTransaction): { tooLarge: boolean; raw: number } {
  const raw = getRawTxBytes(tx);
  return { tooLarge: raw > MAX_RAW_TX_BYTES, raw };
}
