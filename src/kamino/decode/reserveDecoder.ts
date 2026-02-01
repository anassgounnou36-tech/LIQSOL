import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Buffer } from "buffer";
import { DecodedReserve } from "../types.js";
import { hasDiscriminator } from "./discriminator.js";
import { toBigInt } from "../../utils/bn.js";

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
 * Extracts non-null oracle public keys from Reserve's TokenInfo configuration
 */
function extractOraclePubkeys(tokenInfo: {
  pythConfiguration?: { price?: { toString: () => string } };
  switchboardConfiguration?: {
    priceAggregator?: { toString: () => string };
    twapAggregator?: { toString: () => string };
  };
  scopeConfiguration?: { priceFeed?: { toString: () => string } };
}): string[] {
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
  accountData: Uint8Array | Buffer,
  reservePubkey: PublicKey
): DecodedReserve {
  // Check discriminator before decoding
  const dataBuffer = Buffer.from(accountData);
  if (!hasDiscriminator(dataBuffer, "Reserve")) {
    throw new Error(
      `Invalid account data: expected Reserve discriminator. ` +
      `Available account types: ${idlJson.accounts.map((a: { name: string }) => a.name).join(", ")}`
    );
  }

  // Decode using Anchor BorshAccountsCoder
  const decoded = accountsCoder.decode("Reserve", dataBuffer);

  // Extract oracle pubkeys from config
  const oraclePubkeys = extractOraclePubkeys(decoded.config?.tokenInfo);

  // Map to DecodedReserve type with BN-safe conversion
  const result = {
    reservePubkey: reservePubkey.toString(),
    marketPubkey: decoded.lendingMarket.toString(),
    liquidityMint: decoded.liquidity.mintPubkey.toString(),
    collateralMint: decoded.collateral.mintPubkey.toString(),
    liquidityDecimals: Number(decoded.liquidity.mintDecimals),
    collateralDecimals: Number(decoded.collateral.mintDecimals),
    oraclePubkeys,
    loanToValueRatio: Number(decoded.config.loanToValuePct),
    liquidationThreshold: Number(decoded.config.liquidationThresholdPct),
    liquidationBonus: Number(decoded.config.maxLiquidationBonusBps),
    borrowFactor: Number(decoded.config.borrowFactorPct || 100), // Default to 100% if not set
    totalBorrowed: toBigInt(decoded.liquidity.borrowedAmountSf).toString(),
    availableLiquidity: toBigInt(decoded.liquidity.availableAmount).toString(),
    cumulativeBorrowRate: toBigInt(decoded.liquidity.cumulativeBorrowRateBsf).toString(),
  };

  return result;
}

