import { AddressLookupTableAccount, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

export async function buildVersionedTx(opts: {
  payer: PublicKey;
  blockhash: string;
  instructions: TransactionInstruction[];
  lookupTables?: AddressLookupTableAccount[];
  signer: Keypair;
}): Promise<VersionedTransaction> {
  const msg = new TransactionMessage({
    payerKey: opts.payer,
    recentBlockhash: opts.blockhash,
    instructions: opts.instructions,
  });

  const luts = opts.lookupTables ?? [];
  const compiled = luts.length > 0
    ? msg.compileToV0Message(luts)
    : msg.compileToLegacyMessage();

  if (luts.length > 0) {
    console.log(`[Executor] compiled v0 with ${luts.length} LUTs`);
  }

  const tx = new VersionedTransaction(compiled);
  tx.sign([opts.signer]);
  return tx;
}
