import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'node:buffer';

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
  // PR2: Mock mode support for testing
  mockMode?: boolean; // if true, returns empty instructions (no network calls)
  mockQuoteFn?: () => Promise<JupiterQuoteResponse>; // inject mock quote response
  mockSwapFn?: () => Promise<JupiterSwapResponse>; // inject mock swap response
}

/**
 * PR2: Helper to convert UI amount string to base units (u64) with exact string→integer conversion (no float math)
 * @param amountUi - Amount in UI units as a string (e.g., "100.50")
 * @param decimals - Number of decimals for the mint
 * @returns Amount in base units as bigint
 */
export function parseUiAmountToBaseUnits(amountUi: string, decimals: number): bigint {
  // Split into integer and fractional parts
  const parts = amountUi.split('.');
  const integerPart = parts[0] || '0';
  const fractionalPart = parts[1] || '';
  
  // Pad or truncate fractional part to match decimals
  const paddedFractional = fractionalPart.padEnd(decimals, '0').slice(0, decimals);
  
  // Combine into a single integer string
  const baseUnitsStr = integerPart + paddedFractional;
  
  // Convert to bigint (handles large numbers correctly)
  return BigInt(baseUnitsStr);
}

/**
 * Fetch best route from Jupiter and build swap instructions for dry-run simulation.
 * Requires network access to https://quote-api.jup.ag (unless mockMode is enabled).
 * Returns setup + swap + cleanup instructions as TransactionInstruction[].
 * 
 * PR2: Supports mock mode for testing without network calls.
 * When mockMode is true or mock functions are provided, network calls are skipped.
 */
export async function buildJupiterSwapIxs(p: SwapParams): Promise<TransactionInstruction[]> {
  // PR2: Mock mode - return empty instructions for testing
  if (p.mockMode && !p.mockQuoteFn && !p.mockSwapFn) {
    console.log('[Swap] Mock mode enabled - returning empty instructions');
    return [];
  }
  
  // PR2: Use exact string→integer conversion (no float math)
  const amountBaseUnits = parseUiAmountToBaseUnits(p.amountUi, p.fromDecimals);
  const slippageBps = p.slippageBps ?? 50;

  // 1) Quote
  let quote: JupiterQuoteResponse;
  if (p.mockQuoteFn) {
    quote = await p.mockQuoteFn();
  } else {
    const quoteUrl = new URL('https://quote-api.jup.ag/v6/quote');
    quoteUrl.searchParams.set('inputMint', p.fromMint);
    quoteUrl.searchParams.set('outputMint', p.toMint);
    quoteUrl.searchParams.set('amount', amountBaseUnits.toString());
    quoteUrl.searchParams.set('slippageBps', String(slippageBps));
    quoteUrl.searchParams.set('onlyDirectRoutes', 'false');
    const quoteResp = await fetch(quoteUrl.toString());
    if (!quoteResp.ok) throw new Error(`Jupiter quote failed: ${quoteResp.statusText}`);
    quote = await quoteResp.json() as JupiterQuoteResponse;
  }
  
  const route = quote?.data?.[0];
  if (!route) {
    console.warn('No Jupiter route available for requested swap.');
    return [];
  }

  // 2) Swap instructions (structured)
  let swapIxsJson: JupiterSwapResponse;
  if (p.mockSwapFn) {
    swapIxsJson = await p.mockSwapFn();
  } else {
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
    swapIxsJson = await swapResp.json() as JupiterSwapResponse;
  }

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
