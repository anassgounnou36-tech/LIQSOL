import { Buffer } from "buffer";

/**
 * Parses the decimals field from a Solana SPL Token Mint account data buffer.
 * 
 * SPL Token Mint account structure:
 * - Bytes 0-35: mint_authority (Option<Pubkey>)
 * - Bytes 36-43: supply (u64)
 * - Byte 44: decimals (u8)
 * - Byte 45: is_initialized (bool)
 * - Bytes 46-81: freeze_authority (Option<Pubkey>)
 * 
 * @param data - Raw account data buffer from a Mint account
 * @returns The decimals value (0-255), or null if data is invalid or too short
 */
export function parseSplMintDecimals(data: Buffer): number | null {
  // Mint account must be at least 45 bytes to contain the decimals field at byte 44
  if (!data || data.length < 45) {
    return null;
  }
  
  // Read decimals at byte offset 44
  const decimals = data[44];
  
  // Validate that decimals is a valid integer (0-255)
  // The buffer value will always be 0-255, but we check it's defined
  return Number.isInteger(decimals) ? decimals : null;
}
