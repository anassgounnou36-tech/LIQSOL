import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { logger } from "../observability/logger.js";
import type { ReserveCache } from "./reserveCache.js";

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
 * Switchboard V2 aggregator discriminator
 * Reference: https://github.com/switchboard-xyz/switchboard-v2
 */
const SWITCHBOARD_V2_DISCRIMINATOR = Buffer.from([
  0x21, 0x7f, 0xc8, 0xf4, 0x64, 0x00, 0x00, 0x00,
]);

/**
 * Decodes a Pyth price account
 * Based on Pyth V2 on-chain data structure
 *
 * @param data - Raw account data
 * @returns Decoded price data or null if invalid
 */
function decodePythPrice(data: Buffer): OraclePriceData | null {
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
    // We convert to approximate slot for freshness checks
    const timestamp = data.readBigInt64LE(104);

    if (status !== 1) {
      logger.debug({ status }, "Pyth price status not trading");
    }

    return {
      price: price,
      confidence: confidence,
      slot: timestamp > 0n ? timestamp : 0n,
      exponent: exponent,
      oracleType: "pyth",
    };
  } catch (err) {
    logger.error({ err }, "Failed to decode Pyth price");
    return null;
  }
}

/**
 * Decodes a Switchboard V2 aggregator account
 * Based on Switchboard V2 on-chain data structure
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

    // Verify discriminator at offset 0
    // Note: Some Switchboard accounts may not have the standard discriminator
    // We attempt to decode regardless and validate based on data structure
    const discriminator = data.subarray(0, 8);
    const hasValidDiscriminator = discriminator.equals(SWITCHBOARD_V2_DISCRIMINATOR);
    
    if (!hasValidDiscriminator) {
      logger.debug("Switchboard discriminator mismatch, attempting best-effort decode");
    }

    // Latest confirmed round result starts around offset 217
    // Value: i128 stored as two i64s (mantissa at 217, scale implicit)
    // For simplicity, read as f64 representation if available
    
    // Switchboard stores value as SwitchboardDecimal (i128 with scale)
    // Read mantissa: i64 at offset 217
    const mantissa = data.readBigInt64LE(217);
    
    // Scale: u32 at offset 225 (number of decimal places)
    const scale = data.readUInt32LE(225);
    
    // Standard deviation (confidence proxy): i64 at offset 249
    const stdDev = data.readBigInt64LE(249);
    
    // Last update timestamp: i64 at offset 129
    const lastUpdate = data.readBigInt64LE(129);

    // Convert to similar format as Pyth
    // Switchboard uses scale (decimals), Pyth uses exponent
    const exponent = -scale;

    return {
      price: mantissa,
      confidence: stdDev > 0n ? stdDev : 0n,
      slot: lastUpdate > 0n ? lastUpdate : 0n,
      exponent: exponent,
      oracleType: "switchboard",
    };
  } catch (err) {
    logger.error({ err }, "Failed to decode Switchboard price");
    return null;
  }
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
        const existing = cache.get(mint);
        if (existing) {
          logger.debug(
            { mint, oldType: existing.oracleType, newType: "pyth" },
            "Multiple oracles for mint, using Pyth"
          );
        }
        cache.set(mint, priceData);
        logger.debug(
          {
            oracle: pubkeyStr,
            mint,
            price: priceData.price.toString(),
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
        const existing = cache.get(mint);
        if (existing) {
          logger.debug(
            { mint, oldType: existing.oracleType, newType: "switchboard" },
            "Multiple oracles for mint, using Switchboard"
          );
        }
        cache.set(mint, priceData);
        logger.debug(
          {
            oracle: pubkeyStr,
            mint,
            price: priceData.price.toString(),
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
