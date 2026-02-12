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
    if (input instanceof PublicKey) {
      return input.toBase58();
    }
    
    // Handle objects with toBase58 method (for SDK compatibility)
    if (input && typeof input === 'object' && 'toBase58' in input && typeof input.toBase58 === 'function') {
      return input.toBase58();
    }
    
    // Handle string addresses
    if (typeof input === 'string') {
      const s = input.trim();
      
      // Basic length check (Solana addresses are typically 32-44 characters in base58)
      if (s.length < 32 || s.length > 44) {
        throw new Error('Invalid address length: must be 32-44 characters');
      }
      
      // Validate by attempting to create a PublicKey
      new PublicKey(s);
      return s;
    }
    
    // Unsupported type
    throw new Error(`Unsupported input type: ${typeof input}`);
  } catch (origError) {
    // Include context and original error message
    const origMsg = origError instanceof Error ? origError.message : String(origError);
    
    // Sanitize input for logging: limit length and mask potentially sensitive data
    let inputRepr: string;
    if (typeof input === 'string') {
      // Truncate long strings, show first and last few chars for addresses
      if (input.length > 50) {
        inputRepr = `"${input.substring(0, 20)}...${input.substring(input.length - 10)}"`;
      } else {
        inputRepr = JSON.stringify(input);
      }
    } else if (input === null || input === undefined) {
      inputRepr = String(input);
    } else if (typeof input === 'object') {
      // For objects, just show the type to avoid exposing internal structure
      inputRepr = `[object ${input.constructor?.name ?? 'Unknown'}]`;
    } else {
      // For primitives (number, boolean), show type and value
      inputRepr = `${typeof input}(${String(input)})`;
    }
    
    throw new Error(`Invalid address (${ctx}): ${inputRepr} - ${origMsg}`);
  }
}
