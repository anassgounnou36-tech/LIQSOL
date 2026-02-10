import { PublicKey, TransactionInstruction, Connection, AddressLookupTableAccount } from '@solana/web3.js';
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
  addressLookupTableAddresses?: string[];
};

type JupiterQuoteResponse = {
  data?: unknown[];
  outAmount?: string;
};

/**
 * Base-units swap builder API (NO UI strings, NO Number conversions)
 */
export interface BuildJupiterSwapOpts {
  inputMint: PublicKey;
  outputMint: PublicKey;
  inAmountBaseUnits: bigint; // exact base units
  slippageBps: number;
  userPubkey: PublicKey;
  connection: Connection;
  fetchFn?: typeof fetch; // allow injection for tests
}

/**
 * Result from building Jupiter swap instructions
 */
export interface BuildJupiterSwapResult {
  setupIxs: TransactionInstruction[];
  swapIxs: TransactionInstruction[];
  cleanupIxs: TransactionInstruction[];
  lookupTables?: AddressLookupTableAccount[];
  estimatedOutAmountBaseUnits?: bigint;
}

/**
 * DEPRECATED: Legacy interface for backward compatibility
 * Use BuildJupiterSwapOpts instead for new code
 */
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
 * Format base units to UI string for logging only.
 * DO NOT use this for amount conversions in transaction building.
 * 
 * @param amount - Amount in base units as bigint
 * @param decimals - Number of decimals for the mint
 * @returns UI string representation (e.g., "100.50")
 */
export function formatBaseUnitsToUiString(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const integerPart = amount / divisor;
  const fractionalPart = amount % divisor;
  
  if (fractionalPart === 0n) {
    return integerPart.toString();
  }
  
  // Pad fractional part with leading zeros if needed
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  // Trim trailing zeros
  const trimmedFractional = fractionalStr.replace(/0+$/, '');
  
  return `${integerPart}.${trimmedFractional}`;
}

/**
 * Build Jupiter swap instructions using base-units API (NO UI strings, NO Number conversions).
 * 
 * Jupiter quote receives amount as base units string (bigint.toString()).
 * Returns setup + swap + cleanup instructions with optional lookup tables.
 * 
 * @param opts - Swap builder options with base units
 * @returns Swap instructions and metadata
 */
export async function buildJupiterSwapIxs(opts: BuildJupiterSwapOpts): Promise<BuildJupiterSwapResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const slippageBps = opts.slippageBps;

  console.log('[SwapBuilder] Building Jupiter swap (base-units API)');
  console.log(`[SwapBuilder]   Input: ${opts.inputMint.toBase58()}`);
  console.log(`[SwapBuilder]   Output: ${opts.outputMint.toBase58()}`);
  console.log(`[SwapBuilder]   Amount: ${opts.inAmountBaseUnits} base units`);
  console.log(`[SwapBuilder]   Slippage: ${slippageBps} bps`);

  // 1) Quote - pass amount as base units string
  const quoteUrl = new URL('https://quote-api.jup.ag/v6/quote');
  quoteUrl.searchParams.set('inputMint', opts.inputMint.toBase58());
  quoteUrl.searchParams.set('outputMint', opts.outputMint.toBase58());
  quoteUrl.searchParams.set('amount', opts.inAmountBaseUnits.toString()); // bigint → string, NO float conversion
  quoteUrl.searchParams.set('slippageBps', String(slippageBps));
  quoteUrl.searchParams.set('onlyDirectRoutes', 'false');

  let quoteResp;
  try {
    quoteResp = await fetchFn(quoteUrl.toString());
    if (!quoteResp.ok) {
      throw new Error(`Jupiter quote failed: ${quoteResp.statusText}`);
    }
  } catch (err) {
    console.error('[SwapBuilder] Quote request failed:', err instanceof Error ? err.message : String(err));
    throw err;
  }

  const quote = await quoteResp.json() as JupiterQuoteResponse;
  const route = quote?.data?.[0];
  if (!route) {
    console.warn('[SwapBuilder] No Jupiter route available for requested swap.');
    return {
      setupIxs: [],
      swapIxs: [],
      cleanupIxs: [],
    };
  }

  // Extract estimated output amount if available
  let estimatedOutAmountBaseUnits: bigint | undefined;
  if (quote.outAmount) {
    try {
      estimatedOutAmountBaseUnits = BigInt(quote.outAmount);
      console.log(`[SwapBuilder]   Estimated output: ${estimatedOutAmountBaseUnits} base units`);
    } catch {
      console.warn('[SwapBuilder] Failed to parse outAmount as bigint');
    }
  }

  // 2) Swap instructions (structured)
  let swapResp;
  try {
    swapResp = await fetchFn('https://quote-api.jup.ag/v6/swap-instructions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: route,
        userPublicKey: opts.userPubkey.toBase58(),
        wrapUnwrapSol: true,
        useTokenLedger: false,
        asLegacyTransaction: true,
      }),
    });
    
    if (!swapResp.ok) {
      throw new Error(`Jupiter swap-instructions failed: ${swapResp.statusText}`);
    }
  } catch (err) {
    console.error('[SwapBuilder] Swap instructions request failed:', err instanceof Error ? err.message : String(err));
    throw err;
  }

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

  // Lookup tables (optional)
  let lookupTables: AddressLookupTableAccount[] | undefined;
  if (swapIxsJson.addressLookupTableAddresses && swapIxsJson.addressLookupTableAddresses.length > 0) {
    // Load lookup tables from chain
    lookupTables = [];
    for (const address of swapIxsJson.addressLookupTableAddresses) {
      try {
        const lut = await opts.connection.getAddressLookupTable(new PublicKey(address));
        if (lut.value) {
          lookupTables.push(lut.value);
        }
      } catch (err) {
        console.warn(`[SwapBuilder] Failed to load lookup table ${address}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  console.log(`[SwapBuilder] Built ${setupIxs.length} setup, ${swapIxs.length} swap, ${cleanupIxs.length} cleanup instructions`);

  return {
    setupIxs,
    swapIxs,
    cleanupIxs,
    lookupTables,
    estimatedOutAmountBaseUnits,
  };
}

/**
 * DEPRECATED: Legacy swap builder for backward compatibility.
 * 
 * Fetch best route from Jupiter and build swap instructions for dry-run simulation.
 * Requires network access to https://quote-api.jup.ag (unless mockMode is enabled).
 * Returns setup + swap + cleanup instructions as TransactionInstruction[].
 * 
 * PR2: Supports mock mode for testing without network calls.
 * When mockMode is true or mock functions are provided, network calls are skipped.
 * 
 * @deprecated Use buildJupiterSwapIxs with BuildJupiterSwapOpts instead
 */
export async function buildJupiterSwapIxsLegacy(p: SwapParams): Promise<TransactionInstruction[]> {
  // PR2: Mock mode - return empty instructions for testing
  if (p.mockMode && !p.mockQuoteFn && !p.mockSwapFn) {
    console.log('[Swap] Mock mode enabled - returning empty instructions');
    return [];
  }
  
  // Import helper for UI to base units conversion
  const { parseUiAmountToBaseUnits } = await import('./amount.js');
  
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
