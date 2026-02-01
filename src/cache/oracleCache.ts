import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { logger } from "../observability/logger.js";
import type { ReserveCache } from "./reserveCache.js";
import { parsePriceData } from "@pythnetwork/client";

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
  /** Oracle type (pyth, switchboard) */
  oracleType: "pyth" | "switchboard";
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
function decodePythPrice(data: Buffer): OraclePriceData | null {
  try {
    // Use official Pyth SDK to parse price data
    const priceData = parsePriceData(data);
    
    // Check if price is valid (status = trading)
    if (priceData.status !== 1) {
      logger.debug({ status: priceData.status }, "Pyth price status not trading");
      return null;
    }

    // Check for valid price
    if (priceData.price === undefined || priceData.price === null || 
        priceData.confidence === undefined || priceData.confidence === null) {
      logger.debug("Pyth price or confidence is null");
      return null;
    }

    // Staleness check: Pyth uses timestamp (unix timestamp)
    const timestamp = BigInt(priceData.timestamp || 0);
    const currentTime = BigInt(Math.floor(Date.now() / 1000));
    const ageSeconds = Number(currentTime - timestamp);
    
    if (ageSeconds > STALENESS_THRESHOLD_SECONDS) {
      logger.debug(
        { ageSeconds, threshold: STALENESS_THRESHOLD_SECONDS },
        "Pyth price is stale, skipping"
      );
      return null;
    }

    return {
      price: BigInt(priceData.price),
      confidence: BigInt(priceData.confidence),
      slot: timestamp, // Use timestamp as slot proxy
      exponent: priceData.exponent,
      oracleType: "pyth",
    };
  } catch (err) {
    logger.error({ err }, "Failed to decode Pyth price with SDK");
    return null;
  }
}

/**
 * Decodes a Switchboard V2 aggregator account
 * Note: Using manual decoding because @switchboard-xyz/switchboard-v2 is deprecated
 * and has an incompatible API
 *
 * @param data - Raw account data
 * @returns Decoded price data or null if invalid
 */
function decodeSwitchboardPrice(data: Buffer): OraclePriceData | null {
  try {
    // Check minimum size (Switchboard V2 aggregators are ~500 bytes)
    if (data.length < 200) {
      return null;
    }

    // Latest confirmed round result starts around offset 217
    // Value: i128 stored as two i64s (mantissa at 217, scale implicit)
    // For simplicity, read as f64 representation if available
    
    // Switchboard stores value as SwitchboardDecimal (i128 with scale)
    // Read mantissa: i64 at offset 217
    const mantissa = data.readBigInt64LE(217);
    
    // Scale: u32 at offset 225 (number of decimal places)
    // Oracle scale values are typically small (0-18), so safe to convert to Number
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

    // Convert to similar format as Pyth
    // Switchboard uses scale (decimals), Pyth uses exponent
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

  // Batch fetch oracle accounts
  const BATCH_SIZE = 100;
  const allOracleAccounts: Array<{
    pubkey: PublicKey;
    data: Buffer | null;
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
      });
    }
  }

  logger.info(
    { fetched: allOracleAccounts.length },
    "Fetched oracle account data"
  );

  // Decode oracle accounts and map to mints
  const cache = new Map<string, OraclePriceData>();
  let pythCount = 0;
  let switchboardCount = 0;
  let failedCount = 0;

  for (const { pubkey, data } of allOracleAccounts) {
    if (!data) {
      logger.warn(
        { pubkey: pubkey.toString() },
        "Oracle account has no data"
      );
      failedCount++;
      continue;
    }

    const pubkeyStr = pubkey.toString();
    const mints = oracleToMints.get(pubkeyStr);
    if (!mints || mints.size === 0) {
      continue;
    }

    // Try decoding as Pyth first
    let priceData = decodePythPrice(data);
    if (priceData) {
      pythCount++;
      // Store for each mint that uses this oracle
      // Note: If a mint has multiple oracles, the last one wins
      for (const mint of mints) {
        // Apply stablecoin price clamping
        const clampedPrice = applyStablecoinClamp(priceData.price, priceData.exponent, mint);
        const adjustedPriceData = { ...priceData, price: clampedPrice };
        
        const existing = cache.get(mint);
        if (existing) {
          logger.debug(
            { mint, oldType: existing.oracleType, newType: "pyth" },
            "Multiple oracles for mint, using Pyth"
          );
        }
        cache.set(mint, adjustedPriceData);
        logger.debug(
          {
            oracle: pubkeyStr,
            mint,
            price: adjustedPriceData.price.toString(),
            type: "pyth",
          },
          "Cached Pyth oracle"
        );
      }
      continue;
    }

    // Try decoding as Switchboard
    priceData = decodeSwitchboardPrice(data);
    if (priceData) {
      switchboardCount++;
      // Store for each mint that uses this oracle
      for (const mint of mints) {
        // Apply stablecoin price clamping
        const clampedPrice = applyStablecoinClamp(priceData.price, priceData.exponent, mint);
        const adjustedPriceData = { ...priceData, price: clampedPrice };
        
        const existing = cache.get(mint);
        if (existing) {
          logger.debug(
            { mint, oldType: existing.oracleType, newType: "switchboard" },
            "Multiple oracles for mint, using Switchboard"
          );
        }
        cache.set(mint, adjustedPriceData);
        logger.debug(
          {
            oracle: pubkeyStr,
            mint,
            price: adjustedPriceData.price.toString(),
            type: "switchboard",
          },
          "Cached Switchboard oracle"
        );
      }
      continue;
    }

    // If neither decoder worked, log and skip
    logger.warn(
      { pubkey: pubkeyStr, dataLength: data.length },
      "Failed to decode oracle account as Pyth or Switchboard"
    );
    failedCount++;
  }

  logger.info(
    {
      pyth: pythCount,
      switchboard: switchboardCount,
      failed: failedCount,
      cached: cache.size,
    },
    "Oracle cache loaded successfully"
  );

  return cache;
}
