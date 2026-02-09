/**
 * Well-known Solana token mint addresses
 * Used for allowlist filtering and testing
 */

/** Native SOL (wrapped SOL) */
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** USDC (USD Coin) */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** USDT (Tether USD) */
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** BTC (Wrapped Bitcoin) */
export const BTC_MINT = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E";

/**
 * PR2: Resolve mint label or address to actual mint address
 * Supports:
 * - "USDC" -> EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 * - "SOL" -> So11111111111111111111111111111111111111112
 * - "USDT" -> Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
 * - "BTC" -> 9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E
 * - base58 pubkey strings -> pass-through
 * - Invalid input -> throw error
 * 
 * @param labelOrAddress - Mint label (e.g., "USDC") or base58 address
 * @returns Resolved mint address as string
 * @throws Error if input is invalid
 */
export function resolveMint(labelOrAddress: string): string {
  // Handle known labels
  const upper = labelOrAddress.toUpperCase();
  switch (upper) {
    case "USDC":
      return USDC_MINT;
    case "SOL":
      return SOL_MINT;
    case "USDT":
      return USDT_MINT;
    case "BTC":
      return BTC_MINT;
  }
  
  // Pass through if it looks like a base58 pubkey (32-44 chars, alphanumeric)
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(labelOrAddress)) {
    return labelOrAddress;
  }
  
  // Otherwise, throw error
  throw new Error(
    `Invalid mint label or address: "${labelOrAddress}". ` +
    `Expected a known label (USDC, SOL, USDT, BTC) or a valid base58 public key.`
  );
}
