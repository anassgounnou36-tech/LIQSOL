import { PublicKey } from '@solana/web3.js';

/**
 * Safely convert various input formats to a valid Solana address string,
 * with contextual error messages to pinpoint invalid addresses.
 * 
 * Supports:
 * - PublicKey objects (via toBase58())
 * - String addresses (validated via PublicKey constructor)
 * 
 * @param input - The value to convert to an address string
 * @param ctx - Context string describing where this address is used (e.g., "repayRefresh.programAddress")
 * @returns Valid base58 address string
 * @throws Error with context if input is invalid
 */
export function addressSafe(input: unknown, ctx: string): string {
  try {
    // Handle PublicKey objects
    if (input && typeof (input as any).toBase58 === 'function') {
      return (input as any).toBase58();
    }
    
    // Handle string addresses
    if (typeof input === 'string') {
      const s = input.trim();
      
      // Basic length check (Solana addresses are typically 32-44 characters in base58)
      if (s.length < 32 || s.length > 44) {
        throw new Error('length');
      }
      
      // Validate by attempting to create a PublicKey
      new PublicKey(s);
      return s;
    }
    
    // Unsupported type
    throw new Error('type');
  } catch (origError) {
    // Include context, original value, and original error message
    const origMsg = origError instanceof Error ? origError.message : String(origError);
    throw new Error(`Invalid address (${ctx}): ${JSON.stringify(input)} - ${origMsg}`);
  }
}
