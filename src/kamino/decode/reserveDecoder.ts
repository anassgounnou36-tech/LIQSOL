import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Buffer } from "buffer";
import { DecodedReserve } from "../types.js";
import { hasDiscriminator } from "./discriminator.js";
import { toBigIntSafe } from "../../utils/bn.js";

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Sentinel values used in Scope priceChain arrays to indicate "not set".
 * Scope uses both 0 and 0xFFFF (65535) as padding/sentinel indicators.
 */
const SCOPE_CHAIN_SENTINEL_VALUES = new Set([0, 65535]);

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
 * Safely parse a u8-like value (BN-like, bigint, or number) to a valid 0..255 integer
 * Returns -1 as a sentinel value when the input is undefined/null (missing field)
 * @param v - Value to parse
 * @param fieldName - Field name for error messages
 * @returns Valid u8 integer (0..255), or -1 if value is undefined/null (missing)
 * @throws Error if value exists but is not a valid u8
 */
function parseU8Like(v: unknown, fieldName: string): number {
  // Handle undefined/null - return sentinel value -1 instead of throwing
  if (v === undefined || v === null) {
    return -1;
  }
  
  try {
    let num: number;
    
    // Handle bigint
    if (typeof v === "bigint") {
      num = Number(v);
    }
    // Handle number
    else if (typeof v === "number") {
      num = v;
    }
    // Handle BN-like objects with toString
    else if (typeof v === "object" && "toString" in v) {
      const str = (v as { toString: () => string }).toString();
      if (!/^\d+$/.test(str)) {
        throw new Error(`Invalid numeric string: ${str}`);
      }
      num = parseInt(str, 10);
    }
    // Invalid type
    else {
      throw new Error(`Unsupported type: ${typeof v}`);
    }
    
    // Validate range [0, 255]
    if (!Number.isInteger(num) || num < 0 || num > 255) {
      throw new Error(`Value ${num} is out of u8 range [0, 255]`);
    }
    
    return num;
  } catch (err) {
    throw new Error(`Failed to parse ${fieldName} as u8: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Extracts scope price chain array from Reserve's TokenInfo configuration.
 * The priceChain is an array of Scope oracle indices that form a chain to compute
 * the final USD price via Scope.getPriceFromScopeChain (product of prices at each hop).
 * @returns Array of all price chain indices (1-511), excluding 0 and 65535 sentinels, or null if not configured
 */
function extractScopePriceChain(tokenInfo: {
  scopeConfiguration?: { 
    priceFeed?: { toString: () => string };
    priceChain?: number[];
  };
}): number[] | null {
  const nullPubkey = "11111111111111111111111111111111";
  
  // Only extract if scope is configured with a valid priceFeed
  if (
    !tokenInfo?.scopeConfiguration?.priceFeed ||
    tokenInfo.scopeConfiguration.priceFeed.toString() === nullPubkey
  ) {
    return null;
  }
  
  // priceChain is an array of u16 [4] forming a chain to compute the final USD price
  const priceChain = tokenInfo.scopeConfiguration.priceChain;
  if (!priceChain || !Array.isArray(priceChain) || priceChain.length === 0) {
    return null;
  }
  
  // Filter and validate chain indices
  const validChains: number[] = [];
  for (const chainValue of priceChain) {
    const chain = Number(chainValue);
    
    // Skip sentinel values (0 and 65535) which mean "not set"
    if (SCOPE_CHAIN_SENTINEL_VALUES.has(chain)) {
      continue;
    }
    
    // Validate: chain should be in 1..511 (0 is sentinel, 512+ is out of range)
    if (chain > 0 && chain < 512) {
      validChains.push(chain);
    }
  }
  
  return validChains.length > 0 ? validChains : null;
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
  
  // Extract scope price chain if configured
  const scopePriceChain = extractScopePriceChain(decoded.config?.tokenInfo);

  // Map to DecodedReserve type with BN-safe conversion
  // Use toBigIntSafe to handle potentially missing/undefined fields gracefully
  // Note: cumulativeBorrowRateBsf is a BigFractionBytes structure, not a simple BN
  const result = {
    reservePubkey: reservePubkey.toString(),
    marketPubkey: decoded.lendingMarket.toString(),
    liquidityMint: decoded.liquidity.mintPubkey.toString(),
    collateralMint: decoded.collateral.mintPubkey.toString(),
    liquidityDecimals: parseU8Like(decoded.liquidity.mintDecimals, "liquidity.mintDecimals"),
    collateralDecimals: parseU8Like(decoded.collateral.mintDecimals, "collateral.mintDecimals"),
    oraclePubkeys,
    loanToValueRatio: Number(decoded.config.loanToValuePct),
    liquidationThreshold: Number(decoded.config.liquidationThresholdPct),
    liquidationBonus: Number(decoded.config.maxLiquidationBonusBps),
    borrowFactor: Number(decoded.config.borrowFactorPct || 100), // Default to 100% if not set
    availableAmountRaw: toBigIntSafe(decoded.liquidity?.availableAmount, 0n).toString(),
    borrowedAmountSfRaw: toBigIntSafe(decoded.liquidity?.borrowedAmountSf, 0n).toString(),
    cumulativeBorrowRateBsfRaw: toBigIntSafe(decoded.liquidity?.cumulativeBorrowRateBsf, 0n).toString(),
    collateralMintTotalSupplyRaw: toBigIntSafe(decoded.collateral?.mintTotalSupply, 0n).toString(),
    scopePriceChain,
  };

  return result;
}

