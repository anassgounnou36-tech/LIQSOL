import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { logger } from "../observability/logger.js";
import type { ReserveCache } from "./reserveCache.js";
import { parsePriceData } from "@pythnetwork/client";

/**
 * Pyth Oracle Program ID (Solana mainnet)
 */
const PYTH_PROGRAM_ID = new PublicKey("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");

/**
 * Switchboard V2 Program ID (Solana mainnet)
 */
const SWITCHBOARD_V2_PROGRAM_ID = new PublicKey("SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f");

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
 * Manually decodes a Pyth price account (fallback method)
 * Based on Pyth V2 on-chain data structure
 *
 * @param data - Raw account data
 * @returns Decoded price data or null if invalid
 */
function decodePythPriceManual(data: Buffer): OraclePriceData | null {
  try {
    // Check minimum size (minimum ~3312 bytes for Pyth V2)
    if (data.length < 300) {
      return null;
    }

    // Verify discriminator (magic + version + type)
    // Magic: 0xa1b2c3d4 (4 bytes at offset 0)
    const magic = data.readUInt32LE(0);
    if (magic !== 0xa1b2c3d4) {
      return null;
    }

    // Type: u32 at offset 8 (should be 3 for price account)
    const accountType = data.readUInt32LE(8);
    if (accountType !== 3) {
      return null;
    }

    // Price aggregate data starts at offset 208
    // Price: i64 at offset 208
    const price = data.readBigInt64LE(208);
    
    // Confidence: u64 at offset 216
    const confidence = data.readBigUInt64LE(216);
    
    // Status: u32 at offset 224 (1 = trading, 0 = unknown)
    const status = data.readUInt32LE(224);
    
    // Exponent: i32 at offset 20
    const exponent = data.readInt32LE(20);

    // Slot: u64 at offset 104
    // Note: Pyth stores publish_time (unix timestamp) here
    const timestamp = data.readBigInt64LE(104);

    if (status !== 1) {
      logger.debug({ status }, "Pyth price status not trading");
      return null;
    }

    // Staleness check
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
      price: price,
      confidence: confidence,
      slot: timestamp > 0n ? timestamp : 0n,
      exponent: exponent,
      oracleType: "pyth",
    };
  } catch (err) {
    logger.debug({ err }, "Failed to manually decode Pyth price");
    return null;
  }
}

/**
 * Decodes a Pyth price account using the official Pyth SDK with manual fallback
 *
 * @param data - Raw account data
 * @returns Decoded price data or null if invalid
 */
function decodePythPrice(data: Buffer): OraclePriceData | null {
  // Try SDK first
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
    // SDK failed, try manual decoding
    logger.debug({ err }, "Pyth SDK failed, attempting manual decode");
    return decodePythPriceManual(data);
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

    // Detect oracle type by account owner
    let priceData: OraclePriceData | null = null;
    
    if (owner.equals(PYTH_PROGRAM_ID)) {
      // This is a Pyth oracle
      priceData = decodePythPrice(data);
      if (priceData) {
        pythCount++;
      }
    } else if (owner.equals(SWITCHBOARD_V2_PROGRAM_ID)) {
      // This is a Switchboard oracle
      priceData = decodeSwitchboardPrice(data);
      if (priceData) {
        switchboardCount++;
      }
    } else {
      // Unknown oracle program
      logger.debug(
        {
          pubkey: pubkeyStr,
          owner: owner.toString(),
          expectedPyth: PYTH_PROGRAM_ID.toString(),
          expectedSwitchboard: SWITCHBOARD_V2_PROGRAM_ID.toString(),
        },
        "Oracle account has unknown owner, skipping"
      );
      unknownCount++;
      failedCount++;
      continue;
    }

    if (!priceData) {
      logger.debug(
        { pubkey: pubkeyStr, owner: owner.toString() },
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
      unknown: unknownCount,
      failed: failedCount,
      cached: cache.size,
    },
    "Oracle cache loaded successfully"
  );

  return cache;
}
