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

/**
 * Resolve mint label or address to PublicKey
 * 
 * Supports:
 * - "USDC" -> EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 * - "SOL" -> So11111111111111111111111111111111111111112
 * - "USDT" -> Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
 * - base58 pubkey strings -> converted to PublicKey
 * 
 * @param labelOrAddress - Mint label (e.g., "USDC") or base58 address
 * @returns Resolved mint as PublicKey
 * @throws Error if input is invalid or not a valid base58 public key
 */
export function resolveMint(labelOrAddress: string): PublicKey {
  // Handle known labels
  const upper = labelOrAddress.toUpperCase();
  switch (upper) {
    case "USDC":
      return new PublicKey(USDC_MINT);
    case "SOL":
      return new PublicKey(SOL_MINT);
    case "USDT":
      return new PublicKey(USDT_MINT);
  }
  
  // Try to parse as base58 pubkey
  try {
    return new PublicKey(labelOrAddress);
  } catch (err) {
    throw new Error(
      `Invalid mint label or address: "${labelOrAddress}". ` +
      `Expected a known label (USDC, SOL, USDT) or a valid base58 public key. ` +
      `Error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
