import { PublicKey } from '@solana/web3.js';

/**
 * Well-known Solana token mint addresses
 */

/** Native SOL (wrapped SOL token mint - WSOL) */
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** USDC (USD Coin) */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** USDT (Tether USD) */
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** BTC (Wrapped Bitcoin) */
export const BTC_MINT = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E";

/**
 * Flexible mint resolver that accepts BOTH symbols and base58 pubkeys
 * 
 * This function handles:
 * - Symbol names: "USDC", "SOL", "USDT", "BTC" (case-insensitive)
 * - Base58 mint pubkeys: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", etc.
 * 
 * @param input - Mint symbol (e.g., "USDC") or base58 mint pubkey
 * @returns Resolved mint as PublicKey
 * @throws Error if input is invalid or not a valid base58 public key
 */
export function resolveMintFlexible(input: string): PublicKey {
  // Handle known labels (case-insensitive)
  const upper = input.toUpperCase();
  switch (upper) {
    case "USDC":
      return new PublicKey(USDC_MINT);
    case "SOL":
      return new PublicKey(SOL_MINT);
    case "USDT":
      return new PublicKey(USDT_MINT);
    case "BTC":
      return new PublicKey(BTC_MINT);
  }
  
  // Try to parse as base58 pubkey (32-byte address)
  // Valid base58 pubkeys are typically 32-44 characters
  try {
    const pubkey = new PublicKey(input);
    // Validate it's actually a valid 32-byte public key
    if (pubkey.toBuffer().length === 32) {
      return pubkey;
    }
    throw new Error(`Invalid public key length`);
  } catch (err) {
    throw new Error(
      `Unsupported mint: ${input}. ` +
      `Expected a known symbol (USDC, SOL, USDT, BTC) or a valid base58 mint pubkey. ` +
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
