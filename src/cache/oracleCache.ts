import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { logger } from "../observability/logger.js";
import type { ReserveCache } from "./reserveCache.js";
import { scopeOracleChainMap } from "./reserveCache.js";
import { parsePriceData } from "@pythnetwork/client";
import { OraclePrices } from "@kamino-finance/scope-sdk/dist/@codegen/scope/accounts/index.js";

/**
 * Pyth Oracle Program ID (Solana mainnet)
 */
const PYTH_PROGRAM_ID = new PublicKey("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");

/**
 * Switchboard V2 Program ID (Solana mainnet)
 */
const SWITCHBOARD_V2_PROGRAM_ID = new PublicKey("SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f");

/**
 * Scope Program ID (Kamino Scope Oracle)
 */
const SCOPE_PROGRAM_ID = new PublicKey("HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ");

/**
 * Known stablecoin mints for price clamping
 */
const STABLECOIN_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
]);

/**
 * Staleness threshold in seconds (30 seconds)
 */
const STALENESS_THRESHOLD_SECONDS = 30;

/**
 * Stablecoin price clamp range
 */
const STABLECOIN_MIN_PRICE = 0.99;
const STABLECOIN_MAX_PRICE = 1.01;

/**
 * Oracle price data with confidence and freshness
 */
export interface OraclePriceData {
  /** Current price (scaled, e.g., 1 USD = 1e8 for Pyth) */
  price: bigint;
  /** Price confidence interval */
  confidence: bigint;
  /** Last update slot */
  slot: bigint;
  /** Exponent for price scaling (e.g., -8 means divide by 10^8) */
  exponent: number;
  /** Oracle type (pyth, switchboard, scope) */
  oracleType: "pyth" | "switchboard" | "scope";
}

/**
 * Oracle cache mapping mint to price data
 */
export type OracleCache = Map<string, OraclePriceData>;

/**
 * Decodes a Pyth price account using the official Pyth SDK
 *
 * @param data - Raw account data
 * @returns Decoded price data or null if invalid
 */
function decodePythPriceWithSdk(data: Buffer): OraclePriceData | null {
  try {
    const parsed = parsePriceData(data);
    
    // Check status (1 = trading)
    if (!parsed || parsed.status !== 1) {
      logger.debug({ status: parsed?.status }, "Pyth price status not trading");
      return null;
    }

    // Check for valid price and confidence
    if (parsed.price === undefined || parsed.price === null || 
        parsed.confidence === undefined || parsed.confidence === null) {
      logger.debug("Pyth price or confidence is null");
      return null;
    }

    // Use publishTime for freshness (unix timestamp)
    const publishTime = BigInt(parsed.timestamp || 0);
    const currentTime = BigInt(Math.floor(Date.now() / 1000));
    const ageSeconds = Number(currentTime - publishTime);
    
    if (ageSeconds > STALENESS_THRESHOLD_SECONDS) {
      logger.debug(
        { ageSeconds, threshold: STALENESS_THRESHOLD_SECONDS },
        "Pyth price is stale, skipping"
      );
      return null;
    }

    return {
      price: BigInt(Math.trunc(parsed.price)),
      confidence: BigInt(Math.trunc(parsed.confidence)),
      exponent: parsed.exponent,
      slot: publishTime,
      oracleType: "pyth",
    };
  } catch (err) {
    logger.error({ err }, "Failed to decode Pyth price via SDK");
    return null;
  }
}

/**
 * Decodes a Switchboard V2 aggregator account
 * Note: Using manual decoding due to SDK compatibility issues
 *
 * @param data - Raw account data
 * @returns Decoded price data or null if invalid
 */
function decodeSwitchboardPriceWithSdk(data: Buffer): OraclePriceData | null {
  try {
    // Check minimum size
    if (data.length < 200) {
      return null;
    }

    // Switchboard stores value as SwitchboardDecimal (i128 with scale)
    // Read mantissa: i64 at offset 217
    const mantissa = data.readBigInt64LE(217);
    
    // Scale: u32 at offset 225 (number of decimal places)
    const scale = data.readUInt32LE(225);
    if (scale > Number.MAX_SAFE_INTEGER) {
      logger.warn({ scale }, "Switchboard scale exceeds safe integer bounds");
      return null;
    }
    
    // Standard deviation (confidence proxy): i64 at offset 249
    const stdDev = data.readBigInt64LE(249);
    
    // Last update timestamp: i64 at offset 129
    const lastUpdate = data.readBigInt64LE(129);

    // Staleness check
    const updateTime = lastUpdate > 0n ? lastUpdate : 0n;
    if (updateTime > 0n) {
      const currentTime = BigInt(Math.floor(Date.now() / 1000));
      const ageSeconds = Number(currentTime - updateTime);
      
      if (ageSeconds > STALENESS_THRESHOLD_SECONDS) {
        logger.debug(
          { ageSeconds, threshold: STALENESS_THRESHOLD_SECONDS },
          "Switchboard price is stale, skipping"
        );
        return null;
      }
    }

    // Convert scale to exponent
    const exponent = -Number(scale);

    return {
      price: mantissa,
      confidence: stdDev > 0n ? stdDev : 0n,
      slot: updateTime,
      exponent: exponent,
      oracleType: "switchboard",
    };
  } catch (err) {
    logger.error({ err }, "Failed to decode Switchboard price");
    return null;
  }
}

/**
 * Decodes a Scope price feed account using the Kamino Scope SDK with fallback support
 *
 * @param data - Raw account data
 * @param chains - Array of price chain indices (0-511) to try in order until a valid price is found
 * @returns Decoded price data or null if no valid price found in any chain
 */
function decodeScopePrice(data: Buffer, chains: number[] = [0]): OraclePriceData | null {
  try {
    // Use Scope SDK to decode the OraclePrices account
    const oraclePrices = OraclePrices.decode(data);
    
    if (!oraclePrices || !oraclePrices.prices || oraclePrices.prices.length === 0) {
      logger.debug("Scope OraclePrices has no prices");
      return null;
    }
    
    // Try each chain index in order until we find a valid, fresh price
    for (const chain of chains) {
      // Skip sentinel value
      if (chain === 65535) {
        logger.debug({ chain }, "Skipping Scope chain index 65535 (sentinel value)");
        continue;
      }
      
      // Validate chain index
      if (chain < 0 || chain >= 512) {
        logger.warn({ chain }, "Invalid Scope price chain index (must be 0-511), skipping");
        continue;
      }
      
      // Check if chain index is out of bounds for this oracle
      if (chain >= oraclePrices.prices.length) {
        logger.debug(
          { chain, availablePrices: oraclePrices.prices.length },
          "Scope price chain index out of bounds for this oracle, trying next chain"
        );
        continue;
      }
      
      const datedPrice = oraclePrices.prices[chain];
      if (!datedPrice || !datedPrice.price) {
        logger.debug({ chain }, "Scope DatedPrice or Price is null at chain index, trying next chain");
        continue;
      }
      
      // Extract price components from the Price struct
      const value = datedPrice.price.value; // BN (mantissa)
      const exp = datedPrice.price.exp; // BN (exponent)
      const unixTimestamp = datedPrice.unixTimestamp; // BN (unix timestamp in seconds)
      
      // Guard against zero/invalid price
      const priceBigInt = BigInt(value.toString());
      if (priceBigInt === 0n) {
        logger.debug({ chain, value: priceBigInt.toString() }, "Scope price value is zero at chain index, trying next chain");
        continue;
      }
      
      // Guard against zero timestamp
      const timestamp = BigInt(unixTimestamp.toString());
      if (timestamp === 0n) {
        logger.debug({ chain, timestamp: timestamp.toString() }, "Scope price timestamp is zero at chain index, trying next chain");
        continue;
      }
      
      // Staleness check - use unix timestamp
      const currentTime = BigInt(Math.floor(Date.now() / 1000));
      
      if (timestamp > 0n) {
        const ageSeconds = Number(currentTime - timestamp);
        
        if (ageSeconds > STALENESS_THRESHOLD_SECONDS) {
          logger.debug(
            { chain, ageSeconds, threshold: STALENESS_THRESHOLD_SECONDS },
            "Scope price is stale at chain index, trying next chain"
          );
          continue;
        }
      }
      
      // Found a valid, fresh price!
      const exponent = Number(exp.toString());
      
      logger.debug(
        { 
          chain, 
          price: priceBigInt.toString(), 
          exponent, 
          timestamp: timestamp.toString(),
          triedChains: chains.slice(0, chains.indexOf(chain) + 1)
        },
        `Successfully decoded Scope price using chain index ${chain}`
      );
      
      return {
        price: priceBigInt,
        confidence: 0n, // Scope doesn't provide confidence in the same way
        exponent: exponent,
        slot: timestamp,
        oracleType: "scope",
      };
    }
    
    // No valid price found in any chain
    logger.warn(
      { 
        chains, 
        availablePrices: oraclePrices.prices.length 
      },
      "No usable Scope price found after trying all configured chain indices"
    );
    return null;
  } catch (err) {
    logger.error({ err, chains }, "Failed to decode Scope price with SDK");
    return null;
  }
}

/**
 * Applies stablecoin price clamping to keep prices within expected range
 * 
 * @param price - Raw price
 * @param exponent - Price exponent
 * @param mint - Token mint address
 * @returns Clamped price
 */
function applyStablecoinClamp(price: bigint, exponent: number, mint: string): bigint {
  if (!STABLECOIN_MINTS.has(mint)) {
    return price;
  }

  // Convert price to USD
  const priceUSD = Number(price) * Math.pow(10, exponent);
  
  // Clamp to [0.99, 1.01]
  const clampedUSD = Math.max(STABLECOIN_MIN_PRICE, Math.min(STABLECOIN_MAX_PRICE, priceUSD));
  
  // Convert back to scaled price
  const clampedPrice = BigInt(Math.round(clampedUSD * Math.pow(10, -exponent)));
  
  if (clampedPrice !== price) {
    logger.debug(
      { mint, original: priceUSD, clamped: clampedUSD },
      "Applied stablecoin price clamp"
    );
  }
  
  return clampedPrice;
}

/**
 * Loads oracle price data for all oracles referenced in the reserve cache
 *
 * @param connection - Solana RPC connection
 * @param reserveCache - Previously loaded reserve cache
 * @returns Map of mint (as string) to oracle price data
 */
export async function loadOracles(
  connection: Connection,
  reserveCache: ReserveCache
): Promise<OracleCache> {
  logger.info("Loading oracle data for all reserves...");

  // Collect all unique oracle pubkeys from reserves
  const oraclePubkeySet = new Set<string>();
  const oracleToMints = new Map<string, Set<string>>();

  for (const [mint, reserve] of reserveCache.entries()) {
    for (const oraclePubkey of reserve.oraclePubkeys) {
      const oraclePubkeyStr = oraclePubkey.toString();
      oraclePubkeySet.add(oraclePubkeyStr);

      // Track which mints use this oracle
      if (!oracleToMints.has(oraclePubkeyStr)) {
        oracleToMints.set(oraclePubkeyStr, new Set());
      }
      oracleToMints.get(oraclePubkeyStr)!.add(mint);
    }
  }

  const oraclePubkeys = Array.from(oraclePubkeySet).map(
    (pk) => new PublicKey(pk)
  );

  logger.info(
    { uniqueOracles: oraclePubkeys.length },
    "Fetching oracle accounts..."
  );

  if (oraclePubkeys.length === 0) {
    logger.warn("No oracles found in reserve cache");
    return new Map();
  }

  // Batch fetch oracle accounts (need full account info to check owner)
  const BATCH_SIZE = 100;
  const allOracleAccounts: Array<{
    pubkey: PublicKey;
    data: Buffer | null;
    owner: PublicKey | null;
  }> = [];

  for (let i = 0; i < oraclePubkeys.length; i += BATCH_SIZE) {
    const batch = oraclePubkeys.slice(i, i + BATCH_SIZE);
    logger.debug(
      { batchStart: i, batchSize: batch.length },
      "Fetching batch of oracle accounts..."
    );

    const accounts = await connection.getMultipleAccountsInfo(batch, "confirmed");

    for (let j = 0; j < batch.length; j++) {
      allOracleAccounts.push({
        pubkey: batch[j],
        data: accounts[j]?.data || null,
        owner: accounts[j]?.owner || null,
      });
    }
  }

  logger.info(
    { fetched: allOracleAccounts.length },
    "Fetched oracle account data"
  );

  // Diagnostic: Check oracle coverage
  const reserveCount = reserveCache.size;
  if (oraclePubkeys.length < 10 && reserveCount > 50) {
    logger.warn(
      {
        uniqueOracles: oraclePubkeys.length,
        reserveCount,
        sampleReserves: Array.from(reserveCache.entries()).slice(0, 3).map(([mint, reserve]) => ({
          mint,
          oracleCount: reserve.oraclePubkeys.length,
          oracles: reserve.oraclePubkeys.map(pk => pk.toString()),
        })),
      },
      "WARNING: Very few unique oracles for many reserves - possible configuration issue"
    );
  }

  // Decode oracle accounts and map to mints
  const cache = new Map<string, OraclePriceData>();
  let pythCount = 0;
  let switchboardCount = 0;
  let scopeCount = 0;
  let unknownCount = 0;
  let failedCount = 0;

  for (const { pubkey, data, owner } of allOracleAccounts) {
    if (!data) {
      logger.warn(
        { pubkey: pubkey.toString() },
        "Oracle account has no data"
      );
      failedCount++;
      continue;
    }

    if (!owner) {
      logger.debug(
        { pubkey: pubkey.toString() },
        "Oracle account has no owner"
      );
      failedCount++;
      continue;
    }

    const pubkeyStr = pubkey.toString();
    const mints = oracleToMints.get(pubkeyStr);
    if (!mints || mints.size === 0) {
      continue;
    }

    // Detect oracle type by account owner and route to appropriate decoder
    let priceData: OraclePriceData | null = null;
    const ownerStr = owner.toString();
    
    if (owner.equals(PYTH_PROGRAM_ID)) {
      // Use Pyth SDK decoder
      priceData = decodePythPriceWithSdk(data);
      if (priceData) {
        pythCount++;
      }
    } else if (owner.equals(SWITCHBOARD_V2_PROGRAM_ID)) {
      // Use Switchboard decoder
      priceData = decodeSwitchboardPriceWithSdk(data);
      if (priceData) {
        switchboardCount++;
      }
    } else if (owner.equals(SCOPE_PROGRAM_ID)) {
      // Use Scope decoder with the configured price chain array (with fallback support)
      const chains = scopeOracleChainMap.get(pubkeyStr) ?? [0];
      priceData = decodeScopePrice(data, chains);
      if (priceData) {
        scopeCount++;
        logger.debug(
          { oracle: pubkeyStr, chains },
          `Decoded Scope oracle using price chain array with fallback`
        );
      }
    } else {
      // Unknown oracle program
      logger.debug(
        {
          pubkey: pubkeyStr,
          owner: ownerStr,
          expectedPyth: PYTH_PROGRAM_ID.toString(),
          expectedSwitchboard: SWITCHBOARD_V2_PROGRAM_ID.toString(),
          expectedScope: SCOPE_PROGRAM_ID.toString(),
        },
        "Oracle account has unknown owner, skipping"
      );
      unknownCount++;
      failedCount++;
      continue;
    }

    if (!priceData) {
      logger.warn(
        { pubkey: pubkeyStr, owner: ownerStr },
        "Failed to decode oracle price"
      );
      failedCount++;
      continue;
    }

    // Store for each mint that uses this oracle
    // Note: If a mint has multiple oracles, the last one wins
    for (const mint of mints) {
      // Apply stablecoin price clamping
      const clampedPrice = applyStablecoinClamp(priceData.price, priceData.exponent, mint);
      const adjustedPriceData = { ...priceData, price: clampedPrice };
      
      const existing = cache.get(mint);
      if (existing) {
        logger.debug(
          { mint, oldType: existing.oracleType, newType: priceData.oracleType },
          `Multiple oracles for mint, using ${priceData.oracleType}`
        );
      }
      cache.set(mint, adjustedPriceData);
      logger.debug(
        {
          oracle: pubkeyStr,
          mint,
          price: adjustedPriceData.price.toString(),
          type: priceData.oracleType,
        },
        `Cached ${priceData.oracleType} oracle`
      );
    }
  }

  logger.info(
    {
      pyth: pythCount,
      switchboard: switchboardCount,
      scope: scopeCount,
      unknown: unknownCount,
      failed: failedCount,
      cached: cache.size,
    },
    "Oracle cache loaded successfully"
  );

  return cache;
}
