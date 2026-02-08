import { PublicKey, TransactionInstruction } from '@solana/web3.js';

type JupiterAccountMeta = { pubkey: string; isSigner: boolean; isWritable: boolean };

type JupiterInstruction = {
  programId: string;
  accounts: JupiterAccountMeta[];
  data: string;
};

type JupiterSwapResponse = {
  setupInstructions?: JupiterInstruction[];
  swapInstruction?: JupiterInstruction;
  cleanupInstruction?: JupiterInstruction;
};

type JupiterQuoteResponse = {
  data?: unknown[];
};

export interface SwapParams {
  userPublicKey: PublicKey;
  fromMint: string; // base58
  toMint: string;   // base58
  amountUi: string; // UI units string, e.g. "100"
  fromDecimals: number; // decimals for fromMint to convert UI → base units
  slippageBps?: number; // default 50 (0.5%)
}

/**
 * Fetch best route from Jupiter and build swap instructions for dry-run simulation.
 * Requires network access to https://quote-api.jup.ag.
 * Returns setup + swap + cleanup instructions as TransactionInstruction[].
 */
export async function buildJupiterSwapIxs(p: SwapParams): Promise<TransactionInstruction[]> {
  const amountBaseUnits = BigInt(Math.round(parseFloat(p.amountUi) * Math.pow(10, p.fromDecimals)));
  const slippageBps = p.slippageBps ?? 50;

  // 1) Quote
  const quoteUrl = new URL('https://quote-api.jup.ag/v6/quote');
  quoteUrl.searchParams.set('inputMint', p.fromMint);
  quoteUrl.searchParams.set('outputMint', p.toMint);
  quoteUrl.searchParams.set('amount', amountBaseUnits.toString());
  quoteUrl.searchParams.set('slippageBps', String(slippageBps));
  quoteUrl.searchParams.set('onlyDirectRoutes', 'false');
  const quoteResp = await fetch(quoteUrl.toString());
  if (!quoteResp.ok) throw new Error(`Jupiter quote failed: ${quoteResp.statusText}`);
  const quote = await quoteResp.json() as JupiterQuoteResponse;
  const route = quote?.data?.[0];
  if (!route) {
    console.warn('No Jupiter route available for requested swap.');
    return [];
  }

  // 2) Swap instructions (structured)
  const swapResp = await fetch('https://quote-api.jup.ag/v6/swap-instructions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: route,
      userPublicKey: p.userPublicKey.toBase58(),
      wrapUnwrapSol: true,
      useTokenLedger: false,
      asLegacyTransaction: true,
    }),
  });
  if (!swapResp.ok) throw new Error(`Jupiter swap-instructions failed: ${swapResp.statusText}`);
  const swapIxsJson = await swapResp.json() as JupiterSwapResponse;

  function toIx(ix: JupiterInstruction) {
    const programId = new PublicKey(ix.programId);
    const keys = ix.accounts.map(a => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    }));
    const data = Buffer.from(ix.data, 'base64');
    return new TransactionInstruction({ programId, keys, data });
  }

  const setupIxs: TransactionInstruction[] = (swapIxsJson?.setupInstructions ?? []).map(toIx);
  const swapIxs: TransactionInstruction[] = (swapIxsJson?.swapInstruction ? [toIx(swapIxsJson.swapInstruction)] : []);
  const cleanupIxs: TransactionInstruction[] = (swapIxsJson?.cleanupInstruction ? [toIx(swapIxsJson.cleanupInstruction)] : []);

  return [...setupIxs, ...swapIxs, ...cleanupIxs];
}
