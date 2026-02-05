import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { logger } from "../observability/logger.js";
import type { ReserveCache } from "./reserveCache.js";
import { scopeMintChainMap, getMintsByOracle } from "./reserveCache.js";
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
 * Scope chain overrides for known problematic feeds
 * Maps oracle pubkey to priority-ordered chain indices to try
 */
const scopeChainOverrides: Record<string, number[]> = {
  "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH": [0, 2, 4, 6],
};

/**
 * Sentinel value used in Scope priceChain arrays to indicate "not set"
 * This is 0xFFFF (max u16 value)
 */
const SCOPE_CHAIN_SENTINEL_VALUE = 65535;

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
 * Result from decoding a Scope price with fallback metadata
 */
interface ScopePriceResult {
  /** Decoded price data, or null if no valid price found */
  priceData: OraclePriceData | null;
  /** The chain index that yielded a usable price, if any */
  winningChain?: number;
  /** Whether fallback chain scanning was attempted */
  triedFallbackScan: boolean;
}

/**
 * Cache of resolved chain indices per mint for Scope oracles
 * Maps mint address → successfully resolved chain index
 * Used to avoid repeated fallback scanning for the same mint
 */
const resolvedScopeChainByMint = new Map<string, number>();

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
 * Curated list of common Scope price chain candidates for fallback scanning
 * These are commonly used chain indices observed across Kamino markets
 */
const FALLBACK_CHAIN_CANDIDATES = [
  0, 1, 2, 10, 13, 18, 20, 22, 25, 50, 108, 112, 118, 119, 146, 148, 150, 175,
  202, 208, 210, 211, 212, 213, 214, 215, 216, 217, 219, 220, 221, 222, 223, 224,
  235, 246, 267, 311, 377, 426, 500, 507,
];

/**
 * Helper function to check if a price entry is usable (non-zero, finite exponent, magnitude sanity checks)
 * Note: Does not check for freshness - that is validated separately in tryChain
 * @param priceData - Price data to validate
 * @returns true if the price is usable, false otherwise
 */
function isPriceUsable(priceData: OraclePriceData | null): boolean {
  if (!priceData) return false;
  if (priceData.price === 0n) return false;
  if (!Number.isFinite(priceData.exponent)) return false;

  // Reject absurd exponent ranges
  if (priceData.exponent < -30 || priceData.exponent > 10) return false;

  // Magnitude check without floats: log10(uiPrice) ≈ (digits - 1) + exponent
  const digits = priceData.price.toString().length;
  const approxLog10 = (digits - 1) + priceData.exponent;

  // Reject extremely tiny prices (e.g., ~1e-6 USD)
  if (approxLog10 < -4) return false; // uiPrice < 1e-4

  // Reject extremely huge prices (protect against overflow nonsense)
  if (approxLog10 > 7) return false; // uiPrice > 1e7

  return true;
}

/**
 * Decodes a Scope price feed account using the Kamino Scope SDK with resilient fallback support
 *
 * Behavior:
 * 1. Try configured chains in order
 * 2. If none found and fallback enabled, try primary fallback chains [0, 3]
 * 3. If still none found, scan curated list of common chain indices
 * 4. Return null if no valid price found
 *
 * @param data - Raw account data
 * @param chains - Array of price chain indices (0-511) to try in order until a valid price is found
 * @param options - Optional configuration
 * @param options.enableFallback - Enable automatic fallback chain search (default: true)
 * @returns Result object with price data, winning chain, and fallback metadata
 */
function decodeScopePrice(
  data: Buffer, 
  chains: number[] = [0],
  options?: { enableFallback?: boolean }
): ScopePriceResult {
  try {
    // Use Scope SDK to decode the OraclePrices account
    const oraclePrices = OraclePrices.decode(data);
    
    if (!oraclePrices || !oraclePrices.prices || oraclePrices.prices.length === 0) {
      logger.warn("Scope decode failed: prices array missing");
      return { priceData: null, triedFallbackScan: false };
    }
    
    // Helper function to try decoding a specific chain
    const tryChain = (chain: number): OraclePriceData | null => {
      // Skip sentinel value
      if (chain === SCOPE_CHAIN_SENTINEL_VALUE) {
        logger.debug({ chain }, "Skipping Scope chain index (sentinel value)");
        return null;
      }
      
      // Validate chain index
      if (chain < 0 || chain >= 512) {
        logger.debug({ chain }, "Invalid Scope price chain index (must be 0-511), skipping");
        return null;
      }
      
      // Check if chain index is out of bounds for this oracle
      if (chain >= oraclePrices.prices.length) {
        logger.debug(
          { chain, total: oraclePrices.prices.length },
          "Scope chain index out of bounds"
        );
        return null;
      }
      
      const datedPrice = oraclePrices.prices[chain];
      if (!datedPrice || !datedPrice.price) {
        logger.debug({ chain }, "Scope DatedPrice or Price is null at chain index, trying next chain");
        return null;
      }
      
      // Extract price components from the Price struct
      const value = datedPrice.price.value; // BN (mantissa)
      const exp = datedPrice.price.exp; // BN (exponent)
      const unixTimestamp = datedPrice.unixTimestamp; // BN (unix timestamp in seconds)
      
      // Guard against zero/invalid price
      const priceBigInt = BigInt(value.toString());
      if (priceBigInt <= 0n) {
        logger.debug({ chain, value: priceBigInt.toString() }, "Scope price value invalid (<=0) at chain index");
        return null;
      }
      
      // Guard against invalid exponent (but 0 is valid)
      // Scope's exp is a scale (decimal places), so we need negative exponent for UI price conversion
      // UI price = mantissa × 10^(-exp)
      const exponent = -Number(exp.toString());
      if (!isFinite(exponent)) {
        logger.debug({ chain, exponent }, "Scope price exponent is invalid at chain index");
        return null;
      }
      
      // Guard against zero/invalid timestamp
      const timestamp = BigInt(unixTimestamp?.toString() || "0");
      if (timestamp === 0n) {
        logger.debug({ chain, timestamp: timestamp.toString() }, "Scope price entry invalid/stale (no timestamp)");
        return null;
      }
      
      // Staleness check - use unix timestamp
      const currentTime = BigInt(Math.floor(Date.now() / 1000));
      const ageSeconds = Number(currentTime - timestamp);
      
      if (ageSeconds > STALENESS_THRESHOLD_SECONDS) {
        logger.debug(
          { chain, ageSeconds, threshold: STALENESS_THRESHOLD_SECONDS },
          "Scope price entry invalid/stale"
        );
        return null;
      }
      
      // Extract confidence if available from the feed
      const confidence = BigInt((datedPrice as any).confidence?.toString() || "0");
      
      return {
        price: priceBigInt,
        confidence: confidence,
        exponent: exponent,
        slot: timestamp,
        oracleType: "scope",
      };
    };
    
    // Step 1: Try configured chains in order
    for (const chain of chains) {
      const priceData = tryChain(chain);
      if (isPriceUsable(priceData)) {
        logger.info({ chain, value: priceData!.price.toString(), exponent: priceData!.exponent }, "Scope price selected from configured chains");
        return { priceData, winningChain: chain, triedFallbackScan: false };
      }
    }
    
    // Step 2: Check if fallback is enabled
    const enableFallback = options?.enableFallback ?? true;
    if (!enableFallback) {
      logger.warn(
        { 
          chains, 
          availablePrices: oraclePrices.prices.length 
        },
        "No usable Scope price found in configured chains and fallback disabled"
      );
      return { priceData: null, triedFallbackScan: false };
    }
    
    // Step 3: Try primary fallback chain [0]
    logger.debug({ configuredChains: chains }, "Trying primary fallback chain for Scope price");
    for (const chain of [0]) {
      // Skip if already tried in configured chains
      if (chains.includes(chain)) continue;
      
      const priceData = tryChain(chain);
      if (isPriceUsable(priceData)) {
        logger.info(
          { chain, value: priceData!.price.toString(), exponent: priceData!.exponent, configuredChains: chains },
          "Scope price selected from primary fallback chain"
        );
        return { priceData, winningChain: chain, triedFallbackScan: true };
      }
    }
    
    // Step 4: Check if curated chain scanning is enabled
    // Check dynamically to support test environment flag changes
    const enableScopeScan = (globalThis as any).process?.env?.LIQSOL_ENABLE_SCOPE_SCAN === "1";
    if (!enableScopeScan) {
      logger.warn(
        { 
          chains, 
          availablePrices: oraclePrices.prices.length,
          hint: "Set LIQSOL_ENABLE_SCOPE_SCAN=1 to enable curated chain scanning (not recommended for production)"
        },
        "No usable Scope price found in configured chains and chain 0; curated scan disabled"
      );
      return { priceData: null, triedFallbackScan: false };
    }
    
    // Step 5: Scan curated list of common chain candidates (only when explicitly enabled)
    logger.debug(
      { configuredChains: chains, candidateCount: FALLBACK_CHAIN_CANDIDATES.length },
      "Scanning curated fallback chain candidates for Scope price (LIQSOL_ENABLE_SCOPE_SCAN=1)"
    );
    for (const chain of FALLBACK_CHAIN_CANDIDATES) {
      // Skip if already tried in configured chains or primary fallback
      if (chains.includes(chain) || chain === 0) continue;
      
      const priceData = tryChain(chain);
      if (isPriceUsable(priceData)) {
        logger.info(
          { 
            chain, 
            value: priceData!.price.toString(), 
            exponent: priceData!.exponent, 
            configuredChains: chains,
            scannedCandidates: FALLBACK_CHAIN_CANDIDATES.length
          },
          "Scope price selected from curated fallback candidate scan"
        );
        return { priceData, winningChain: chain, triedFallbackScan: true };
      }
    }
    
    // No valid price found after exhaustive search
    logger.warn(
      { 
        configuredChains: chains,
        availablePrices: oraclePrices.prices.length,
        scannedCandidates: FALLBACK_CHAIN_CANDIDATES.length
      },
      "No usable Scope price found after trying configured chains and fallback scanning"
    );
    return { priceData: null, triedFallbackScan: true };
  } catch (err) {
    logger.error({ err, chains }, "Failed to decode Scope price with SDK");
    return { priceData: null, triedFallbackScan: false };
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
      // Add both liquidity mint AND collateral mint so deposits can resolve prices
      if (!oracleToMints.has(oraclePubkeyStr)) {
        oracleToMints.set(oraclePubkeyStr, new Set());
      }
      oracleToMints.get(oraclePubkeyStr)!.add(mint);
      
      // Also add the collateral mint if it's different
      if (reserve.collateralMint && reserve.collateralMint !== mint) {
        oracleToMints.get(oraclePubkeyStr)!.add(reserve.collateralMint);
      }
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
      // Scope oracles need mint-aware chain selection
      // Decode separately for each mint that uses this oracle
      const assignedMints = getMintsByOracle(reserveCache, pubkeyStr);
      
      if (assignedMints.length === 0) {
        logger.debug({ oracle: pubkeyStr }, "Scope oracle has no assigned mints, skipping");
        continue;
      }
      
      // Store diagnostic entry under oracle pubkey (will be overwritten by first mint's price)
      let diagnosticPriceData: OraclePriceData | null = null;
      
      // Decode price for each mint using its specific chain configuration
      for (const mint of assignedMints) {
        // Build chain precedence: resolved → configured → overrides
        const resolvedChain = resolvedScopeChainByMint.get(mint);
        const configChains = scopeMintChainMap.get(mint) || [];
        const overrideChains = scopeChainOverrides[pubkeyStr] || [];
        
        // Merge chains with correct precedence
        const chainsToTry: number[] = [];
        if (resolvedChain !== undefined) {
          chainsToTry.push(resolvedChain);
        }
        for (const c of configChains) {
          if (!chainsToTry.includes(c)) chainsToTry.push(c);
        }
        for (const c of overrideChains) {
          if (!chainsToTry.includes(c)) chainsToTry.push(c);
        }
        
        // If empty after merge, use default [0]
        const finalChains = chainsToTry.length > 0 ? chainsToTry : [0];
        
        const result = decodeScopePrice(data, finalChains);
        
        if (!result.priceData) {
          logger.warn(
            { 
              oracle: pubkeyStr, 
              mint, 
              chains: finalChains,
              triedFallbackScan: result.triedFallbackScan
            },
            "Failed to decode Scope price for mint after fallback search"
          );
          continue;
        }
        
        // Cache the winning chain for this mint to avoid future fallback scans
        if (result.winningChain !== undefined && result.triedFallbackScan) {
          resolvedScopeChainByMint.set(mint, result.winningChain);
          logger.info(
            { 
              mint, 
              resolvedChain: result.winningChain,
              originalChains: finalChains
            },
            "Cached resolved Scope chain for mint (found via fallback)"
          );
        }
        
        // Apply stablecoin price clamping per mint
        const clampedPrice = applyStablecoinClamp(result.priceData.price, result.priceData.exponent, mint);
        const adjustedPriceData = { ...result.priceData, price: clampedPrice };
        
        // Store price under mint
        cache.set(mint, adjustedPriceData);
        scopeCount++;
        
        // Store first successful decode as diagnostic entry
        if (!diagnosticPriceData) {
          diagnosticPriceData = adjustedPriceData;
        }
        
        logger.debug(
          {
            oracle: pubkeyStr,
            mint,
            chains: finalChains,
            winningChain: result.winningChain,
            usedFallback: result.triedFallbackScan,
            price: adjustedPriceData.price.toString(),
          },
          "Mapped Scope oracle price to mint with chain-aware decoding"
        );
      }
      
      // Store diagnostic entry under oracle pubkey
      if (diagnosticPriceData) {
        cache.set(pubkeyStr, diagnosticPriceData);
      }
      
      // Skip the generic price mapping below since we handled it per-mint above
      continue;
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

    // Store oracle price under oracle pubkey for diagnostics
    cache.set(pubkeyStr, priceData);

    // Map to all mints that reference this oracle
    const assignedMints = getMintsByOracle(reserveCache, pubkeyStr);
    let assigned = 0;
    
    for (const mint of assignedMints) {
      // Apply stablecoin price clamping per mint
      const clampedPrice = applyStablecoinClamp(priceData.price, priceData.exponent, mint);
      const adjustedPriceData = { ...priceData, price: clampedPrice };
      
      cache.set(mint, adjustedPriceData);
      assigned++;
      
      logger.debug(
        {
          oracle: pubkeyStr,
          mint,
          price: adjustedPriceData.price.toString(),
          type: priceData.oracleType,
        },
        `Mapped ${priceData.oracleType} oracle price to mint`
      );
    }
    
    if (assigned === 0) {
      logger.warn(
        { oracle: pubkeyStr, type: priceData.oracleType },
        "Decoded oracle but no reserves reference it; not counted as cached"
      );
      failedCount++;
    } else {
      // Count successful oracle decode
      if (owner.equals(SCOPE_PROGRAM_ID)) {
        scopeCount++;
      }
      logger.debug(
        { oracle: pubkeyStr, type: priceData.oracleType, mintsAssigned: assigned },
        `Successfully mapped oracle to ${assigned} mint(s)`
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
