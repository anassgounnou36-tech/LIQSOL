import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Buffer } from "buffer";
import { DecodedObligation } from "../types.js";
import { hasDiscriminator } from "./discriminator.js";
import { toBigInt, gtZero } from "../../utils/bn.js";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Kamino Lending Program ID (mainnet)
 * Source: https://github.com/Kamino-Finance/klend-sdk
 */
export const KAMINO_LENDING_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);

// Load the klend IDL from the repo-pinned file
const idlPath = join(__dirname, "..", "idl", "klend.json");
const idlJson = JSON.parse(readFileSync(idlPath, "utf-8"));

// Create BorshAccountsCoder for decoding accounts
const accountsCoder = new BorshAccountsCoder(idlJson);

/**
 * Placeholder value used when reserve mint information is not available
 * during obligation decoding. In production, mints should be fetched from
 * the chain or provided via setReserveMintCache().
 */
const UNKNOWN_MINT_PLACEHOLDER = "unknown-mint-fetch-required";

/**
 * Cache mapping reserve pubkeys to their associated token mints.
 * This is used by decodeObligation() to populate mint fields in deposits and borrows.
 * 
 * Note: Obligation accounts store reserve pubkeys but not the token mints.
 * To get the mint, you need to either:
 * 1. Fetch the Reserve account and extract the mint
 * 2. Use this cache if you've already decoded the Reserve
 * 
 * Usage:
 *   // After decoding a Reserve
 *   const reserve = decodeReserve(reserveData, reservePubkey);
 *   setReserveMintCache(reserve.reservePubkey, reserve.liquidityMint);
 *   
 *   // Later when decoding Obligation
 *   const obligation = decodeObligation(obligationData, obligationPubkey);
 *   // obligation.deposits[].mint will use cached values
 */
const reserveMintCache = new Map<string, string>();

/**
 * Sets the token mint for a given reserve in the cache.
 * Used to populate mint fields when decoding Obligation accounts.
 * 
 * @param reservePubkey - Public key of the reserve (as string)
 * @param mint - Token mint public key (as string)
 */
export function setReserveMintCache(reservePubkey: string, mint: string): void {
  reserveMintCache.set(reservePubkey, mint);
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
  // Check discriminator before decoding
  const dataBuffer = Buffer.from(accountData);
  if (!hasDiscriminator(dataBuffer, "Obligation")) {
    throw new Error(
      `Invalid account data: expected Obligation discriminator. ` +
      `Available account types: ${idlJson.accounts.map((a: { name: string }) => a.name).join(", ")}`
    );
  }

  // Decode using Anchor BorshAccountsCoder
  const decoded = accountsCoder.decode("obligation", dataBuffer);

  // Map deposits (collateral) - filter using gtZero
  const deposits = (
    decoded.deposits as Array<{
      depositReserve: { toString: () => string };
      depositedAmount: unknown;
    }>
  )
    .filter((d) => gtZero(d.depositedAmount))
    .map((d) => ({
      reserve: d.depositReserve.toString(),
      mint:
        reserveMintCache.get(d.depositReserve.toString()) ||
        UNKNOWN_MINT_PLACEHOLDER,
      depositedAmount: toBigInt(d.depositedAmount).toString(),
    }));

  // Map borrows - filter using gtZero
  const borrows = (
    decoded.borrows as Array<{
      borrowReserve: { toString: () => string };
      borrowedAmountSf: unknown;
    }>
  )
    .filter((b) => gtZero(b.borrowedAmountSf))
    .map((b) => ({
      reserve: b.borrowReserve.toString(),
      mint:
        reserveMintCache.get(b.borrowReserve.toString()) ||
        UNKNOWN_MINT_PLACEHOLDER,
      borrowedAmount: toBigInt(b.borrowedAmountSf).toString(),
    }));

  return {
    obligationPubkey: obligationPubkey.toString(),
    ownerPubkey: decoded.owner.toString(),
    marketPubkey: decoded.lendingMarket.toString(),
    lastUpdateSlot: decoded.lastUpdate.slot.toString(),
    deposits,
    borrows,
  };
}

