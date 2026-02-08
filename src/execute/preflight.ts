import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@kamino-finance/klend-sdk';
import type { Address } from '@solana/addresses';

/** Check payer SOL balance meets minimum lamports */
export async function checkSolBalance(connection: Connection, pubkey: PublicKey, minLamports: number): Promise<boolean> {
  const bal = await connection.getBalance(pubkey);
  return bal >= minLamports;
}

/** Compute ATA for owner/mint and check existence */
export async function checkATAExists(connection: Connection, owner: PublicKey, mint: PublicKey): Promise<{ ata: PublicKey; exists: boolean }> {
  const ataStr = await getAssociatedTokenAddress(mint.toBase58() as Address, owner.toBase58() as Address);
  const ata = new PublicKey(ataStr);
  const info = await connection.getAccountInfo(ata);
  return { ata, exists: !!info };
}

/** Basic validation of instruction array */
export function validateInstructions(ixs: TransactionInstruction[]): boolean {
  if (!Array.isArray(ixs) || ixs.length === 0) return false;
  return ixs.every(ix => ix.programId && ix.keys && Array.isArray(ix.keys));
}
