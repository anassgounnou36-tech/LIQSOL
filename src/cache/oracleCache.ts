import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { logger } from "../observability/logger.js";
import type { ReserveCache } from "./reserveCache.js";
import { scopeMintChainMap, getMintsByOracle } from "./reserveCache.js";
import { parsePriceData } from "@pythnetwork/client";
import { OraclePrices } from "@kamino-finance/scope-sdk/dist/@codegen/scope/accounts/index.js";
import { Scope } from "@kamino-finance/scope-sdk";
import { SOL_MINT, USDC_MINT, USDT_MINT } from "../constants/mints.js";
import { uiPriceFromMantissa } from "../utils/priceConversion.js";

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
 * Decodes a Scope price feed using the Scope SDK chain pricing function.
 * Computes the final USD price from the full price chain (a product of prices at each hop).
 *
 * The chain is the array of Scope price indices that form a multi-hop price path
 * (e.g., [lstIndex, solIndex] → LST/SOL * SOL/USD = LST/USD).
 *
 * @param data - Raw account data
 * @param chains - Scope price chain (full array of indices to compute the final USD price)
 * @returns OraclePriceData with the computed USD price, or null if invalid/stale
 */
function decodeScopePrice(
  data: Buffer,
  chains: number[]
): OraclePriceData | null {
  // Validate chain
  if (!chains || chains.length === 0) {
    logger.warn({ chain: chains }, "[OracleCache] Empty Scope chain");
    return null;
  }

  if (!Scope.isScopeChainValid(chains)) {
    logger.warn({ chain: chains }, "[OracleCache] Invalid Scope chain");
    return null;
  }

  // Decode the OraclePrices account
  const oraclePrices = OraclePrices.decode(data);

  if (!oraclePrices || !oraclePrices.prices || oraclePrices.prices.length === 0) {
    logger.warn("[OracleCache] Scope decode failed: prices array missing");
    return null;
  }

  try {
    // Compute USD price from the full chain
    const result = Scope.getPriceFromScopeChain(chains, oraclePrices);

    // Staleness check using the oldest timestamp in the chain
    const timestampSec = result.timestamp.toNumber();
    const ageSec = Date.now() / 1000 - timestampSec;
    if (ageSec > STALENESS_THRESHOLD_SECONDS) {
      logger.warn(
        { chain: chains, ageSec, threshold: STALENESS_THRESHOLD_SECONDS },
        "[OracleCache] Scope chain price is stale"
      );
      return null;
    }

    const uiPrice = result.price.toNumber();

    // Validate result
    if (!isFinite(uiPrice) || isNaN(uiPrice) || uiPrice <= 0) {
      logger.warn({ chain: chains, uiPrice }, "[OracleCache] Scope chain returned invalid price");
      return null;
    }

    // Magnitude check (USD prices should be in reasonable range)
    if (uiPrice < 0.0001 || uiPrice > 1_000_000) {
      logger.warn({ chain: chains, uiPrice }, "[OracleCache] Scope chain price magnitude out of range");
      return null;
    }

    // Convert Decimal USD price to internal format with fixed exponent -8
    const exponent = -8;
    const price = BigInt(Math.floor(uiPrice * 1e8));

    if (price <= 0n) {
      logger.warn({ chain: chains, price }, "[OracleCache] Non-positive Scope chain price after conversion");
      return null;
    }

    logger.debug(
      { chain: chains, uiPrice, exponent, timestampSec, ageSec },
      "[OracleCache] Scope chain priced"
    );

    return {
      price,
      confidence: 0n,
      exponent,
      slot: BigInt(Math.floor(timestampSec)),
      oracleType: "scope",
    };
  } catch (err) {
    logger.warn(
      { chain: chains, err: err instanceof Error ? err.message : String(err) },
      "[OracleCache] Scope chain pricing failed"
    );
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
 * Performs oracle sanity checks after cache is loaded
 * Prevents false positives from bad oracle data (wrong SOL price, stale data, etc.)
 * 
 * @param cache - Oracle cache to validate
 * @param allowedLiquidityMints - Optional set of allowed liquidity mints (for allowlist mode)
 * @throws Error if critical sanity checks fail
 */
function performOracleSanityChecks(
  cache: OracleCache,
  allowedLiquidityMints?: Set<string>
): void {
  // Check 1: Fail fast if oracle cache is empty in allowlist mode
  if (allowedLiquidityMints && allowedLiquidityMints.size > 0 && cache.size === 0) {
    throw new Error(
      "No oracle prices loaded for allowlist mints; check Scope chain selection / enable bounded scan"
    );
  }
  
  // Check 2: SOL price sanity check (critical for preventing false positives)
  const allowlistMode = !!(allowedLiquidityMints && allowedLiquidityMints.size > 0);
  const solPrice = cache.get(SOL_MINT);
  const solUiPrice = solPrice ? uiPriceFromMantissa(solPrice.price, solPrice.exponent) : null;

  if (allowlistMode) {
    // Allowlist mode: if SOL is allowlisted, require it
    if (allowedLiquidityMints!.has(SOL_MINT)) {
      if (!solPrice) {
        const errorMsg = 'SOL is allowlisted but missing from oracle cache - check reserve/oracle configuration';
        logger.error({ solMint: SOL_MINT }, errorMsg);
        throw new Error(errorMsg);
      }

      if (!solUiPrice || solUiPrice < 5 || solUiPrice > 2000) {
        const errorMsg = solUiPrice
          ? `Invalid SOL price from Scope (${solUiPrice.toFixed(2)} USD); aborting scoring to prevent false positives`
          : "Invalid SOL price from Scope (could not compute UI price); aborting scoring";

        logger.error(
          {
            solMint: SOL_MINT,
            solPrice: solPrice ? { price: solPrice.price.toString(), exponent: solPrice.exponent } : null,
            solUiPrice,
            allowedRange: { min: 5, max: 2000 }
          },
          errorMsg
        );

        throw new Error(errorMsg);
      }

      logger.info(
        { solMint: SOL_MINT, solUiPrice: solUiPrice.toFixed(2) },
        "SOL price sanity check passed"
      );
    }
  } else {
    // Full-market mode: validate SOL only if present in cache (non-fatal).
    // Range [10, 1000] is tighter than allowlist mode [5, 2000] because in full-market
    // we only warn (never throw), so the range targets obviously-corrupt prices.
    if (solPrice && solUiPrice !== null) {
      if (solUiPrice < 10 || solUiPrice > 1000) {
        logger.warn({ solMint: SOL_MINT, solUiPrice }, 'SOL price outside expected range (10-1000 USD)');
      } else {
        logger.info({ solMint: SOL_MINT, solUiPrice }, 'SOL price sanity check passed');
      }
    }
  }
  
  // Check 3: Stablecoin price sanity checks (warn only, don't fail)
  for (const stableMint of [USDC_MINT, USDT_MINT]) {
    if (!allowedLiquidityMints || allowedLiquidityMints.has(stableMint)) {
      const stablePrice = cache.get(stableMint);
      const stableUiPrice = stablePrice ? uiPriceFromMantissa(stablePrice.price, stablePrice.exponent) : null;
      
      if (stableUiPrice && (stableUiPrice < 0.95 || stableUiPrice > 1.05)) {
        logger.warn(
          { 
            mint: stableMint,
            uiPrice: stableUiPrice.toFixed(4),
            expectedRange: { min: 0.95, max: 1.05 }
          },
          "Stablecoin price outside expected range [0.95, 1.05]"
        );
        
        // Optional: Apply clamping if CLAMP_STABLECOINS env is set
        // Note: Clamping is also done in applyStablecoinClamp(), so this is redundant
        // but we log it here for visibility
        if ((globalThis as any).process?.env?.CLAMP_STABLECOINS === "1") {
          logger.info(
            { mint: stableMint },
            "CLAMP_STABLECOINS=1 - stablecoin clamping already applied during cache load"
          );
        }
      }
    }
  }
  
  logger.info("Oracle sanity checks completed");
}

/**
 * Loads oracle price data for all oracles referenced in the reserve cache
 *
 * @param connection - Solana RPC connection
 * @param reserveCache - Previously loaded reserve cache
 * @param allowedLiquidityMints - Optional set of allowed liquidity mints (for allowlist mode detection)
 * @returns Map of mint (as string) to oracle price data
 */
export async function loadOracles(
  connection: Connection,
  reserveCache: ReserveCache,
  allowedLiquidityMints?: Set<string>
): Promise<OracleCache> {
  logger.info("Loading oracle data for all reserves...");

  // Detect allowlist mode (any non-empty allowlist)
  const allowlistMode = !!(allowedLiquidityMints && allowedLiquidityMints.size > 0);

  // Cache LIQSOL_ENABLE_SCOPE_SCAN flag
  const scopeScanEnvEnabled = (globalThis as any).process?.env?.LIQSOL_ENABLE_SCOPE_SCAN === '1';

  logger.info({
    mode: allowlistMode ? 'allowlist' : 'full-market',
    allowlistSize: allowedLiquidityMints?.size ?? 0
  }, 'Oracle loading mode');

  if (scopeScanEnvEnabled && !allowlistMode) {
    logger.warn('[OracleCache] LIQSOL_ENABLE_SCOPE_SCAN is set but ignored in full-market mode (empty allowlist)');
  }

  // Collect all unique oracle pubkeys from reserves
  const oraclePubkeySet = new Set<string>();
  const oracleToMints = new Map<string, Set<string>>();

  for (const [mint, reserve] of reserveCache.byMint.entries()) {
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
  // Note: Scope oracles use shared feed accounts, so few unique oracles is expected
  if (oraclePubkeys.length < 10 && reserveCache.byReserve.size > 50) {
    logger.warn(
      {
        cached: oraclePubkeys.length,
        reserveCount: reserveCache.byReserve.size,
        note: 'Scope oracles use shared feed accounts',
      },
      "Oracle coverage check"
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
      
      // Store diagnostic entry under oracle pubkey (first mint's price)
      let diagnosticPriceData: OraclePriceData | null = null;
      
      // Decode price for each mint using its reserve-configured Scope price chain
      for (const mint of assignedMints) {
        // Use only the reserve-configured Scope price chain (array of indices for chain product)
        const configChains = scopeMintChainMap.get(mint) || [];
        // Default to [0] if no chain configured (single-element chain)
        const finalChains = configChains.length > 0 ? configChains : [0];
        
        const priceData = decodeScopePrice(data, finalChains);
        
        if (!priceData) {
          logger.warn(
            { oracle: pubkeyStr, mint, chains: finalChains },
            "Failed to decode Scope price for mint"
          );
          continue;
        }
        
        // Apply stablecoin price clamping per mint
        const clampedPrice = applyStablecoinClamp(priceData.price, priceData.exponent, mint);
        const adjustedPriceData = { ...priceData, price: clampedPrice };
        
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
            price: adjustedPriceData.price.toString(),
          },
          "Mapped Scope oracle price to mint via chain pricing"
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

  // Coverage summary: report how many mints have prices vs. missing
  const pricedMints = new Set<string>();
  const unpricedMints = new Set<string>();
  for (const [mint] of cache.entries()) {
    pricedMints.add(mint);
  }
  for (const [mint] of reserveCache.byMint.entries()) {
    if (!pricedMints.has(mint)) {
      unpricedMints.add(mint);
    }
  }
  logger.info(
    {
      reserveCount: reserveCache.byReserve.size,
      pricedMints: pricedMints.size,
      unpricedMints: unpricedMints.size,
      unpricedSample: Array.from(unpricedMints).slice(0, 5),
    },
    "[OracleCache] Oracle coverage summary"
  );

  // Part B: Oracle sanity checks (prevent false positives)
  performOracleSanityChecks(cache, allowedLiquidityMints);

  return cache;
}
