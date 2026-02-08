import { TransactionInstruction } from '@solana/web3.js';

export interface SwapParams {
  fromMint: string;
  toMint: string;
  amountUi: string;
}

export async function buildSwapIxs(_p: SwapParams): Promise<TransactionInstruction[]> {
  // Placeholder: integrate Jupiter in a future PR (quotes/routes, token programs)
  return [];
}
