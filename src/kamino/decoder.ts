import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { DecodedReserve, DecodedObligation } from "./types.js";

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
const idlPath = join(__dirname, "idl", "klend.json");
const idlJson = JSON.parse(readFileSync(idlPath, "utf-8"));

// Create BorshAccountsCoder for decoding accounts
const accountsCoder = new BorshAccountsCoder(idlJson);

/**
 * Extracts non-null oracle public keys from Reserve's TokenInfo configuration
 */
function extractOraclePubkeys(tokenInfo: any): string[] {
  const oracles: string[] = [];
  const nullPubkey = "11111111111111111111111111111111";

  // Extract Pyth price feed
  if (
    tokenInfo?.pythConfiguration?.price &&
    tokenInfo.pythConfiguration.price.toString() !== nullPubkey
  ) {
    oracles.push(tokenInfo.pythConfiguration.price.toString());
  }

  // Extract Switchboard price aggregators
  if (
    tokenInfo?.switchboardConfiguration?.priceAggregator &&
    tokenInfo.switchboardConfiguration.priceAggregator.toString() !== nullPubkey
  ) {
    oracles.push(
      tokenInfo.switchboardConfiguration.priceAggregator.toString()
    );
  }

  if (
    tokenInfo?.switchboardConfiguration?.twapAggregator &&
    tokenInfo.switchboardConfiguration.twapAggregator.toString() !== nullPubkey
  ) {
    oracles.push(tokenInfo.switchboardConfiguration.twapAggregator.toString());
  }

  // Extract Scope price feed
  if (
    tokenInfo?.scopeConfiguration?.priceFeed &&
    tokenInfo.scopeConfiguration.priceFeed.toString() !== nullPubkey
  ) {
    oracles.push(tokenInfo.scopeConfiguration.priceFeed.toString());
  }

  return oracles;
}

/**
 * Decodes a Reserve account from Kamino Lending protocol
 * @param accountData - Raw account data buffer
 * @param reservePubkey - Public key of the reserve account
 * @returns Decoded Reserve with structured fields
 */
export function decodeReserve(
  accountData: Buffer,
  reservePubkey: PublicKey
): DecodedReserve {
  // Decode using Anchor BorshAccountsCoder
  const decoded = accountsCoder.decode("reserve", accountData);

  // Extract oracle pubkeys from config
  const oraclePubkeys = extractOraclePubkeys(decoded.config?.tokenInfo);

  // Map to DecodedReserve type
  return {
    reservePubkey: reservePubkey.toString(),
    marketPubkey: decoded.lendingMarket.toString(),
    liquidityMint: decoded.liquidity.mintPubkey.toString(),
    collateralMint: decoded.collateral.mintPubkey.toString(),
    liquidityDecimals: Number(decoded.liquidity.mintDecimals),
    collateralDecimals: Number(decoded.liquidity.mintDecimals), // Typically same as liquidity
    oraclePubkeys,
    loanToValueRatio: Number(decoded.config.loanToValuePct),
    liquidationThreshold: Number(decoded.config.liquidationThresholdPct),
    liquidationBonus: Number(decoded.config.maxLiquidationBonusBps),
    totalBorrowed: decoded.liquidity.borrowedAmountSf.toString(),
    availableLiquidity: decoded.liquidity.availableAmount.toString(),
  };
}

/**
 * Helper to get reserve mint for a reserve pubkey (used by obligation decoder)
 * This would need to be fetched from the chain in a real scenario.
 * For testing, this can be populated from fixture data.
 */
const reserveMintCache = new Map<string, string>();

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
  accountData: Buffer,
  obligationPubkey: PublicKey
): DecodedObligation {
  // Decode using Anchor BorshAccountsCoder
  const decoded = accountsCoder.decode("obligation", accountData);

  // Map deposits (collateral)
  const deposits = decoded.deposits
    .filter((d: any) => d.depositedAmount > 0)
    .map((d: any) => ({
      reserve: d.depositReserve.toString(),
      mint:
        reserveMintCache.get(d.depositReserve.toString()) ||
        "unknown-mint-fetch-required",
      depositedAmount: d.depositedAmount.toString(),
    }));

  // Map borrows
  const borrows = decoded.borrows
    .filter((b: any) => b.borrowedAmountSf > 0)
    .map((b: any) => ({
      reserve: b.borrowReserve.toString(),
      mint:
        reserveMintCache.get(b.borrowReserve.toString()) ||
        "unknown-mint-fetch-required",
      borrowedAmount: b.borrowedAmountSf.toString(),
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
