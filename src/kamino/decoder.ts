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
 * Sets both liquidity and collateral mints for a given reserve in the caches.
 * Used to populate mint fields when decoding Obligation accounts.
 * 
 * @param reservePubkey - Public key of the reserve (as string)
 * @param liquidityMint - Liquidity token mint public key (as string) - used for borrows
 * @param collateralMint - Collateral token mint public key (as string) - used for deposits
 */
export function setReserveMintCache(
  reservePubkey: string,
  liquidityMint: string,
  collateralMint: string
): void {
  setReserveMintCacheImpl(reservePubkey, liquidityMint, collateralMint);
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

