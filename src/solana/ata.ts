import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

/**
 * Build an idempotent create ATA instruction for the given owner+mint under specific token program id.
 */
export function buildCreateAtaIdempotentIx(params: {
  payer: PublicKey;
  owner: PublicKey;
  ata: PublicKey;
  mint: PublicKey;
  tokenProgramId: PublicKey;
}): TransactionInstruction {
  const { payer, owner, ata, mint, tokenProgramId } = params;
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ata,
    owner,
    mint,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}
