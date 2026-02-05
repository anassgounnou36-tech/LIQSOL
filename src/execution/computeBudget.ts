import { ComputeBudgetProgram, TransactionInstruction } from "@solana/web3.js";

export interface ComputeBudgetOpts {
  cuLimit?: number;
  cuPriceMicroLamports?: number;
}

/**
 * Build compute budget instructions for transaction optimization.
 * 
 * @param opts - Optional configuration for compute unit limit and price
 * @returns Array of compute budget instructions to prepend to transaction
 */
export function buildComputeBudgetIxs(opts?: ComputeBudgetOpts): TransactionInstruction[] {
  const cuLimit = opts?.cuLimit ?? 600_000;
  const cuPriceMicroLamports = opts?.cuPriceMicroLamports ?? 0;

  const ixs: TransactionInstruction[] = [];

  // Set compute unit limit
  ixs.push(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: cuLimit,
    })
  );

  // Set compute unit price if specified
  if (cuPriceMicroLamports > 0) {
    ixs.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: cuPriceMicroLamports,
      })
    );
  }

  return ixs;
}
