import { afterEach, describe, expect, it } from 'vitest';
import { Connection, PublicKey } from '@solana/web3.js';
import { buildJupiterSwapIxs } from '../src/execute/swapBuilder.js';

describe('Swap builder legacy mode flag', () => {
  afterEach(() => {
    delete process.env.JUPITER_AS_LEGACY_TRANSACTION;
  });

  it('defaults asLegacyTransaction to false for quote and swap-instructions', async () => {
    const observed: { quoteUrl?: string; swapBody?: { asLegacyTransaction?: boolean } } = {};
    const mockConnection = { getAddressLookupTable: async () => ({ context: { slot: 0 }, value: null }) } as unknown as Connection;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/v6/quote')) {
        observed.quoteUrl = url;
        return new Response(JSON.stringify({ data: [{}], outAmount: '1' }), { status: 200 });
      }
      observed.swapBody = JSON.parse(String(init?.body)) as { asLegacyTransaction?: boolean };
      return new Response(JSON.stringify({ setupInstructions: [], addressLookupTableAddresses: [] }), { status: 200 });
    };

    await buildJupiterSwapIxs({
      inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
      outputMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      inAmountBaseUnits: 1n,
      slippageBps: 100,
      userPubkey: new PublicKey('11111111111111111111111111111111'),
      connection: mockConnection,
      fetchFn,
    });

    expect(observed.quoteUrl).toContain('asLegacyTransaction=false');
    expect(observed.swapBody?.asLegacyTransaction).toBe(false);
  });

  it('uses env override when JUPITER_AS_LEGACY_TRANSACTION=true', async () => {
    process.env.JUPITER_AS_LEGACY_TRANSACTION = 'true';
    const observed: { quoteUrl?: string; swapBody?: { asLegacyTransaction?: boolean } } = {};
    const mockConnection = { getAddressLookupTable: async () => ({ context: { slot: 0 }, value: null }) } as unknown as Connection;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/v6/quote')) {
        observed.quoteUrl = url;
        return new Response(JSON.stringify({ data: [{}], outAmount: '1' }), { status: 200 });
      }
      observed.swapBody = JSON.parse(String(init?.body)) as { asLegacyTransaction?: boolean };
      return new Response(JSON.stringify({ setupInstructions: [], addressLookupTableAddresses: [] }), { status: 200 });
    };

    await buildJupiterSwapIxs({
      inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
      outputMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      inAmountBaseUnits: 1n,
      slippageBps: 100,
      userPubkey: new PublicKey('11111111111111111111111111111111'),
      connection: mockConnection,
      fetchFn,
    });

    expect(observed.quoteUrl).toContain('asLegacyTransaction=true');
    expect(observed.swapBody?.asLegacyTransaction).toBe(true);
  });
});
