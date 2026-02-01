import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { logger } from "../observability/logger.js";
import type { ReserveCache } from "./reserveCache.js";
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
 * Decodes a Scope price feed account using the Kamino Scope SDK
 *
 * @param data - Raw account data
 * @returns Decoded price data or null if invalid
 */
function decodeScopePrice(data: Buffer): OraclePriceData | null {
  try {
    // Use Scope SDK to decode the OraclePrices account
    const oraclePrices = OraclePrices.decode(data);
    
    if (!oraclePrices || !oraclePrices.prices || oraclePrices.prices.length === 0) {
      logger.debug("Scope OraclePrices has no prices");
      return null;
    }
    
    // Get the first price (price ID 0)
    const datedPrice = oraclePrices.prices[0];
    if (!datedPrice || !datedPrice.price) {
      logger.debug("Scope DatedPrice or Price is null");
      return null;
    }
    
    // Extract price components from the Price struct
    const value = datedPrice.price.value; // BN (mantissa)
    const exp = datedPrice.price.exp; // BN (exponent)
    const unixTimestamp = datedPrice.unixTimestamp; // BN (unix timestamp in seconds)
    
    // Staleness check - use unix timestamp
    const currentTime = BigInt(Math.floor(Date.now() / 1000));
    const timestamp = BigInt(unixTimestamp.toString());
    
    if (timestamp > 0n) {
      const ageSeconds = Number(currentTime - timestamp);
      
      if (ageSeconds > STALENESS_THRESHOLD_SECONDS) {
        logger.debug(
          { ageSeconds, threshold: STALENESS_THRESHOLD_SECONDS },
          "Scope price is stale, skipping"
        );
        return null;
      }
    }
    
    // Convert to our format
    // Scope stores value as mantissa and exp as exponent
    // Price = value * 10^exp
    const priceBigInt = BigInt(value.toString());
    const exponent = Number(exp.toString());
    
    return {
      price: priceBigInt,
      confidence: 0n, // Scope doesn't provide confidence in the same way
      exponent: exponent,
      slot: timestamp,
      oracleType: "scope",
    };
  } catch (err) {
    logger.error({ err }, "Failed to decode Scope price with SDK");
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
      // Use Scope decoder
      priceData = decodeScopePrice(data);
      if (priceData) {
        scopeCount++;
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
