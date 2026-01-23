import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { DecodedReserve, DecodedObligation } from "./types.js";
import { decodeReserve as decodeReserveImpl } from "./decode/reserveDecoder.js";
import { decodeObligation as decodeObligationImpl, setReserveMintCache as setReserveMintCacheImpl, KAMINO_LENDING_PROGRAM_ID } from "./decode/obligationDecoder.js";

// Re-export for backward compatibility
export { KAMINO_LENDING_PROGRAM_ID };

/**
 * Decodes a Reserve account from Kamino Lending protocol
 * @param accountData - Raw account data buffer
 * @param reservePubkey - Public key of the reserve account
 * @returns Decoded Reserve with structured fields
 */
export function decodeReserve(
  accountData: Uint8Array | Buffer,
  reservePubkey: PublicKey
): DecodedReserve {
  return decodeReserveImpl(accountData, reservePubkey);
}

/**
 * Sets the token mint for a given reserve in the cache.
 * Used to populate mint fields when decoding Obligation accounts.
 * 
 * @param reservePubkey - Public key of the reserve (as string)
 * @param mint - Token mint public key (as string)
 */
export function setReserveMintCache(reservePubkey: string, mint: string): void {
  setReserveMintCacheImpl(reservePubkey, mint);
}

/**
 * Decodes an Obligation account from Kamino Lending protocol
 * @param accountData - Raw account data buffer
 * @param obligationPubkey - Public key of the obligation account
 * @returns Decoded Obligation with structured fields
 */
export function decodeObligation(
  accountData: Uint8Array | Buffer,
  obligationPubkey: PublicKey
): DecodedObligation {
  return decodeObligationImpl(accountData, obligationPubkey);
}

