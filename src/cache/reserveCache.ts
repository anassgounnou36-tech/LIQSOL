import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import bs58 from "bs58";
import { logger } from "../observability/logger.js";
import { decodeReserve, setReserveMintCache } from "../kamino/decoder.js";
import { anchorDiscriminator } from "../kamino/decode/discriminator.js";
import type { DecodedReserve } from "../kamino/types.js";
import { divBigintToNumber } from "../utils/bn.js";
import { parseSplMintDecimals } from "../utils/splMint.js";

/**
 * Kamino Lending Program ID (mainnet)
 */
const KAMINO_LENDING_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);

/**
 * Reserve data stored in the cache
 */
export interface ReserveCacheEntry {
  /** Public key of the reserve account */
  reservePubkey: PublicKey;
  /** Liquidity mint public key (underlying asset mint for pricing) */
  liquidityMint: string;
  /** Collateral mint public key (for mapping deposits to reserves) */
  collateralMint: string;
  /** Available liquidity amount (raw, not adjusted for decimals) */
  availableAmount: bigint;
  /** 
   * Cumulative borrow rate (big scaled fraction / BSF)
   * Used to convert borrowedAmountSf to actual token amounts
   */
  cumulativeBorrowRate: bigint;
  /** 
   * Raw cumulative borrow rate (BigFractionBytes as bigint)
   * Used in health computation to convert borrowedAmountSf to tokens
   */
  cumulativeBorrowRateBsfRaw: bigint;
  /** Loan-to-value ratio (percentage 0-100) */
  loanToValue: number;
  /** Liquidation threshold (percentage 0-100) */
  liquidationThreshold: number;
  /** Liquidation bonus (basis points) */
  liquidationBonus: number;
  /** Borrow factor (percentage 0-100) for risk-adjusted debt valuation */
  borrowFactor: number;
  /** Array of oracle public keys for price feeds */
  oraclePubkeys: PublicKey[];
  /** Liquidity mint decimals for precision calculations */
  liquidityDecimals: number;
  /** Collateral mint decimals for deposit amount normalization */
  collateralDecimals: number;
  /** Scope price chain indices array (0-511) for multi-chain Scope oracles, null if not using Scope */
  scopePriceChain: number[] | null;
  /** 
   * Collateral exchange rate in UI units (computed from reserve state)
   * Used to convert deposit notes (collateral tokens) to underlying liquidity tokens
   */
  collateralExchangeRateUi: number;
}

/**
 * Reserve cache mapping liquidity mint to reserve data
 */
export type ReserveCache = Map<string, ReserveCacheEntry>;

/**
 * Scope mint chain map - maps liquidity mint to priceChain indices array
 * This is populated during reserve loading and used during oracle decoding
 * to select the correct price from multi-chain Scope oracles by trying fallback chains.
 * Different reserves (mints) can share the same Scope oracle but use different chain indices.
 */
export const scopeMintChainMap = new Map<string, number[]>();

/**
 * Computes the collateral exchange rate in UI units from reserve state.
 * 
 * KLend exchange rate formula (from Certora audit):
 * exchangeRateUi = collateralSupplyUi / totalLiquidityUi
 * 
 * This is the inverse of the previous implementation. The rate represents how many
 * collateral tokens are needed to back one unit of underlying liquidity.
 * 
 * To convert deposits (collateral tokens) to underlying liquidity:
 * underlyingLiquidityUi = (depositedNotesUi * totalLiquidityUi) / collateralSupplyUi
 * 
 * Formula details:
 * - borrowedAmountSf is already scaled by 1e18 (WAD), so divide by 1e18 to get raw tokens
 * - totalLiquidityRaw = availableAmountRaw + (borrowedAmountSfRaw / 1e18)
 * - Use bigint mul-div to avoid precision collapse
 * 
 * @param decoded - Decoded reserve with raw state fields
 * @returns Exchange rate in UI units, or 0 if invalid
 */
function computeExchangeRateUi(decoded: DecodedReserve): number {
  // Guard: check for missing decimals (sentinel value -1)
  if (decoded.liquidityDecimals < 0 || decoded.collateralDecimals < 0) {
    logger.warn(
      { reserve: decoded.reservePubkey },
      "Missing mint decimals; skipping exchange rate until fallback resolves"
    );
    return 0;
  }
  
  try {
    const availRaw = BigInt(decoded.availableAmountRaw);
    const borrowSfRaw = BigInt(decoded.borrowedAmountSfRaw);
    const supply = BigInt(decoded.collateralMintTotalSupplyRaw);
    
    // Guard: if supply is zero or negative, exchange rate is undefined
    if (supply <= 0n) {
      return 0;
    }
    
    // Convert borrowedAmountSf to raw tokens
    // borrowedAmountSf is already scaled by 1e18, so divide by 1e18
    const borrowRaw = borrowSfRaw / (10n ** 18n);
    
    // Calculate total liquidity in raw units
    const totalLiquidityRaw = availRaw + borrowRaw;
    
    // Guard: negative liquidity is invalid
    if (totalLiquidityRaw < 0n) {
      logger.warn(
        { 
          reserve: decoded.reservePubkey,
          availableAmountRaw: decoded.availableAmountRaw,
          borrowedAmountSfRaw: decoded.borrowedAmountSfRaw,
          totalLiquidityRaw: totalLiquidityRaw.toString(),
        },
        "Negative total liquidity, defaulting exchange rate to 0"
      );
      return 0;
    }
    
    // Convert to UI units
    const liquidityScale = 10n ** BigInt(decoded.liquidityDecimals);
    const collateralScale = 10n ** BigInt(decoded.collateralDecimals);
    
    const totalLiquidityUi = divBigintToNumber(totalLiquidityRaw, liquidityScale, decoded.liquidityDecimals);
    const collateralSupplyUi = divBigintToNumber(supply, collateralScale, decoded.collateralDecimals);
    
    // Guard: if liquidity is zero, rate is undefined
    if (totalLiquidityUi <= 0) {
      return 0;
    }
    
    // Compute exchange rate: collateralSupplyUi / totalLiquidityUi
    const rate = collateralSupplyUi / totalLiquidityUi;
    
    // Validate result is finite and positive
    return Number.isFinite(rate) && rate > 0 ? rate : 0;
  } catch (error) {
    logger.warn(
      { 
        reserve: decoded.reservePubkey,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        liquidityDecimals: decoded.liquidityDecimals,
        collateralDecimals: decoded.collateralDecimals,
        availableAmountRaw: decoded.availableAmountRaw,
        borrowedAmountSfRaw: decoded.borrowedAmountSfRaw,
        collateralMintTotalSupplyRaw: decoded.collateralMintTotalSupplyRaw
      },
      "Failed to compute exchange rate, defaulting to 0"
    );
    return 0;
  }
}

/**
 * Loads all reserves for a given Kamino market and builds a cache
 * keyed by liquidity mint public key.
 *
 * Strategy:
 * 1. Use getProgramAccounts with discriminator filter to get reserve pubkeys
 * 2. Batch fetch full account data using getMultipleAccountsInfo
 * 3. Decode each reserve and store by liquidity mint
 * 4. Populate setReserveMintCache for obligation decoding
 *
 * @param connection - Solana RPC connection
 * @param marketPubkey - The Kamino lending market public key
 * @param allowlistLiquidityMints - Optional set of liquidity mints to filter reserves early
 * @returns Map of liquidity mint (as string) to ReserveCacheEntry
 */
export async function loadReserves(
  connection: Connection,
  marketPubkey: PublicKey,
  allowlistLiquidityMints?: Set<string>
): Promise<ReserveCache> {
  logger.info(
    { market: marketPubkey.toString() },
    "Loading reserves for market..."
  );
  
  // Log allowlist filtering if enabled
  if (allowlistLiquidityMints && allowlistLiquidityMints.size > 0) {
    logger.info(
      { allowlistMints: Array.from(allowlistLiquidityMints) },
      "Filtering reserves by allowlisted liquidity mints"
    );
  }

  // Calculate discriminator for Reserve accounts
  const reserveDiscriminator = anchorDiscriminator("Reserve");

  logger.debug(
    { discriminator: reserveDiscriminator.toString("hex") },
    "Using Reserve discriminator"
  );

  // Step 1: Get reserve pubkeys using getProgramAccounts with dataSlice
  // to minimize payload
  const filters = [
    {
      memcmp: {
        offset: 0,
        bytes: bs58.encode(reserveDiscriminator),
      },
    },
  ];

  logger.info("Fetching reserve pubkeys via getProgramAccounts...");

  const accountInfos = await connection.getProgramAccounts(
    KAMINO_LENDING_PROGRAM_ID,
    {
      filters,
      encoding: "base64",
      dataSlice: { offset: 0, length: 1 }, // Only get pubkeys, not full data
    }
  );

  logger.info(
    { total: accountInfos.length },
    "Fetched reserve account pubkeys"
  );

  if (accountInfos.length === 0) {
    logger.warn("No reserves found for market");
    return new Map();
  }

  // Extract pubkeys for batch fetching
  const reservePubkeys = accountInfos.map((info) => info.pubkey);

  // Step 2: Batch fetch full account data using getMultipleAccountsInfo
  // Process in chunks to avoid large payload errors
  const BATCH_SIZE = 100;
  const allReserveAccounts: Array<{
    pubkey: PublicKey;
    data: Buffer | null;
  }> = [];

  for (let i = 0; i < reservePubkeys.length; i += BATCH_SIZE) {
    const batch = reservePubkeys.slice(i, i + BATCH_SIZE);
    logger.debug(
      { batchStart: i, batchSize: batch.length },
      "Fetching batch of reserve accounts..."
    );

    const accounts = await connection.getMultipleAccountsInfo(batch, "confirmed");

    for (let j = 0; j < batch.length; j++) {
      allReserveAccounts.push({
        pubkey: batch[j],
        data: accounts[j]?.data || null,
      });
    }
  }

  logger.info(
    { fetched: allReserveAccounts.length },
    "Fetched full reserve account data"
  );

  // Step 3: Decode reserves and filter by market
  const decodedReserves: Array<{ pubkey: PublicKey; decoded: DecodedReserve }> = [];
  let decodedCount = 0;
  let matchedCount = 0;
  let allowlistFilteredCount = 0;

  for (const { pubkey, data } of allReserveAccounts) {
    if (!data) {
      logger.warn({ pubkey: pubkey.toString() }, "Reserve account has no data");
      continue;
    }

    try {
      // Decode the reserve
      const decoded = decodeReserve(data, pubkey);
      decodedCount++;

      // Filter by market
      if (decoded.marketPubkey !== marketPubkey.toString()) {
        logger.debug(
          { reserve: pubkey.toString(), market: decoded.marketPubkey },
          "Reserve belongs to different market, skipping"
        );
        continue;
      }

      // Filter by allowlist if configured (early filtering)
      if (allowlistLiquidityMints && !allowlistLiquidityMints.has(decoded.liquidityMint)) {
        allowlistFilteredCount++;
        logger.debug(
          { reserve: pubkey.toString(), liquidityMint: decoded.liquidityMint },
          "Reserve not in allowlist, skipping"
        );
        continue;
      }

      matchedCount++;
      
      // Store decoded reserve for fallback processing
      decodedReserves.push({ pubkey, decoded });
    } catch (err) {
      logger.error(
        { err, pubkey: pubkey.toString() },
        "Failed to decode reserve"
      );
    }
  }
  
  logger.info(
    {
      decoded: decodedCount,
      matchedMarket: matchedCount,
      allowlistFiltered: allowlistFilteredCount,
    },
    "Decoded reserves, starting SPL Mint fallback for missing decimals..."
  );

  // Step 4: SPL Mint fallback - collect mint pubkeys for reserves with missing decimals
  const mintFallbackMap = new Map<string, { 
    type: "liquidity" | "collateral"; 
    reserves: Array<{ pubkey: PublicKey; decoded: DecodedReserve }> 
  }>();
  
  // Track which reserves have been added to each mint to avoid O(n²) lookups
  const reservesAddedToMint = new Map<string, Set<string>>();
  
  for (const { pubkey, decoded } of decodedReserves) {
    const pubkeyStr = pubkey.toString();
    
    // Check if liquidity decimals are missing (-1)
    if (decoded.liquidityDecimals === -1) {
      const mintKey = decoded.liquidityMint;
      if (!mintFallbackMap.has(mintKey)) {
        mintFallbackMap.set(mintKey, { type: "liquidity", reserves: [] });
        reservesAddedToMint.set(mintKey, new Set());
      }
      
      if (!reservesAddedToMint.get(mintKey)!.has(pubkeyStr)) {
        mintFallbackMap.get(mintKey)!.reserves.push({ pubkey, decoded });
        reservesAddedToMint.get(mintKey)!.add(pubkeyStr);
      }
      
      logger.debug(
        { reserve: pubkeyStr, mint: mintKey },
        "Liquidity mint decimals missing, queuing for SPL fallback"
      );
    }
    
    // Check if collateral decimals are missing (-1)
    if (decoded.collateralDecimals === -1) {
      const mintKey = decoded.collateralMint;
      if (!mintFallbackMap.has(mintKey)) {
        mintFallbackMap.set(mintKey, { type: "collateral", reserves: [] });
        reservesAddedToMint.set(mintKey, new Set());
      }
      
      if (!reservesAddedToMint.get(mintKey)!.has(pubkeyStr)) {
        mintFallbackMap.get(mintKey)!.reserves.push({ pubkey, decoded });
        reservesAddedToMint.get(mintKey)!.add(pubkeyStr);
      }
      
      logger.debug(
        { reserve: pubkeyStr, mint: mintKey },
        "Collateral mint decimals missing, queuing for SPL fallback"
      );
    }
  }
  
  // Fetch mint accounts if there are any missing decimals
  if (mintFallbackMap.size > 0) {
    logger.info(
      { uniqueMints: mintFallbackMap.size },
      "Fetching SPL Mint accounts to resolve missing decimals..."
    );
    
    const mintPubkeys = Array.from(mintFallbackMap.keys()).map(k => new PublicKey(k));
    
    try {
      const mintAccounts = await connection.getMultipleAccountsInfo(mintPubkeys, "confirmed");
      
      let resolvedCount = 0;
      
      for (let i = 0; i < mintPubkeys.length; i++) {
        const mintPubkey = mintPubkeys[i];
        const mintAccount = mintAccounts[i];
        const mintKey = mintPubkey.toString();
        const fallbackInfo = mintFallbackMap.get(mintKey);
        
        if (!mintAccount || !mintAccount.data) {
          logger.warn(
            { mint: mintKey },
            "Mint account not found during fallback, reserves will have invalid decimals"
          );
          continue;
        }
        
        // Parse decimals from mint account data
        const decimals = parseSplMintDecimals(mintAccount.data);
        
        if (decimals === null) {
          logger.warn(
            { mint: mintKey, dataLength: mintAccount.data.length },
            "Failed to parse decimals from mint account data"
          );
          continue;
        }
        
        logger.debug(
          { mint: mintKey, decimals },
          "Resolved decimals from SPL Mint account"
        );
        
        // Apply parsed decimals to all reserves using this mint
        // fallbackInfo is guaranteed to exist since we got mintKey from the map
        for (const { decoded } of fallbackInfo!.reserves) {
          if (decoded.liquidityMint === mintKey && decoded.liquidityDecimals === -1) {
            decoded.liquidityDecimals = decimals;
            resolvedCount++;
            logger.debug(
              { reserve: decoded.reservePubkey, mint: mintKey, decimals },
              "Applied liquidity decimals from SPL fallback"
            );
          }
          if (decoded.collateralMint === mintKey && decoded.collateralDecimals === -1) {
            decoded.collateralDecimals = decimals;
            resolvedCount++;
            logger.debug(
              { reserve: decoded.reservePubkey, mint: mintKey, decimals },
              "Applied collateral decimals from SPL fallback"
            );
          }
        }
      }
      
      logger.info(
        { resolved: resolvedCount },
        "SPL Mint fallback complete, resolved missing decimals"
      );
    } catch (err) {
      logger.error(
        { err },
        "Failed to fetch mint accounts during SPL fallback"
      );
    }
  }

  // Step 5: Build cache and compute exchange rates
  const cache = new Map<string, ReserveCacheEntry>();
  let cachedCount = 0;
  let failedDecodeCount = 0;

  for (const { pubkey, decoded } of decodedReserves) {
    // Final check: skip if decimals are still missing after fallback
    if (decoded.liquidityDecimals < 0 || decoded.collateralDecimals < 0) {
      logger.warn(
        { 
          reserve: pubkey.toString(),
          liquidityDecimals: decoded.liquidityDecimals,
          collateralDecimals: decoded.collateralDecimals,
        },
        "Reserve still has missing decimals after SPL fallback, skipping cache entry"
      );
      failedDecodeCount++;
      continue;
    }

    // Log the liquidity mint mapping for verification
    logger.debug(
      {
        reserve: pubkey.toString(),
        liquidityMint: decoded.liquidityMint,
        marketPubkey: decoded.marketPubkey,
      },
      "Mapping reserve to liquidity mint"
    );

    // Extract oracle pubkeys
    const oraclePubkeys = decoded.oraclePubkeys.map(
      (pk) => new PublicKey(pk)
    );
    
    // If this reserve uses Scope, track the mint→priceChain array mapping for BOTH mints
    // This allows different reserves (mints) to use the same Scope oracle with different chain indices
    // Mapping both liquidity and collateral mints ensures any lookup path finds the configured chains
    if (decoded.scopePriceChain !== null && decoded.scopePriceChain.length > 0) {
      const liquidityMint = decoded.liquidityMint;
      const collateralMint = decoded.collateralMint;
      
      // Map liquidity mint to chain array
      scopeMintChainMap.set(liquidityMint, decoded.scopePriceChain);
      logger.debug(
        {
          reserve: pubkey.toString(),
          liquidityMint: liquidityMint,
          priceChain: decoded.scopePriceChain,
        },
        "Mapped Scope liquidity mint to price chain array"
      );
      
      // Map collateral mint to same chain array
      scopeMintChainMap.set(collateralMint, decoded.scopePriceChain);
      logger.debug(
        {
          reserve: pubkey.toString(),
          collateralMint: collateralMint,
          priceChain: decoded.scopePriceChain,
        },
        "Mapped Scope collateral mint to price chain array"
      );
    }

    // Create cache entry
    const cacheEntry: ReserveCacheEntry = {
      reservePubkey: pubkey,
      liquidityMint: decoded.liquidityMint,
      collateralMint: decoded.collateralMint,
      availableAmount: BigInt(decoded.availableAmountRaw),
      cumulativeBorrowRate: 0n, // Legacy field, not used
      cumulativeBorrowRateBsfRaw: BigInt(decoded.cumulativeBorrowRateBsfRaw),
      loanToValue: decoded.loanToValueRatio,
      liquidationThreshold: decoded.liquidationThreshold,
      liquidationBonus: decoded.liquidationBonus,
      borrowFactor: decoded.borrowFactor,
      oraclePubkeys,
      liquidityDecimals: decoded.liquidityDecimals,
      collateralDecimals: decoded.collateralDecimals,
      scopePriceChain: decoded.scopePriceChain,
      collateralExchangeRateUi: computeExchangeRateUi(decoded),
    };

    // Store in cache keyed by BOTH liquidity and collateral mints
    // This enables lookups by deposit.mint (collateral mint) to find the reserve and prices
    cache.set(decoded.liquidityMint, cacheEntry);
    cache.set(decoded.collateralMint, cacheEntry);
    cachedCount++;

    // Populate setReserveMintCache for obligation decoding
    // CRITICAL: Must pass BOTH liquidity and collateral mints
    // - liquidityMint: used for borrows (pricing, decimals)
    // - collateralMint: used for deposits (exchange rate, decimals)
    setReserveMintCache(pubkey.toString(), decoded.liquidityMint, decoded.collateralMint);

    logger.debug(
      {
        reserve: pubkey.toString(),
        liquidityMint: decoded.liquidityMint,
        collateralMint: decoded.collateralMint,
        availableAmount: cacheEntry.availableAmount.toString(),
        oracleCount: oraclePubkeys.length,
      },
      "Cached reserve with both mints"
    );
  }

  logger.info(
    {
      decoded: decodedCount,
      matchedMarket: matchedCount,
      cached: cachedCount,
      failedDecodeCount,
    },
    "Reserve cache loaded successfully"
  );

  // Validate minimum expected reserves
  // Ensure we have at least 5 reserves for a healthy market
  const MIN_EXPECTED_RESERVES = 5;
  if (cachedCount < MIN_EXPECTED_RESERVES) {
    logger.warn(
      { cached: cachedCount, expected: MIN_EXPECTED_RESERVES },
      "WARNING: Fewer reserves cached than expected - may indicate configuration issue, small market, or RPC problem"
    );
  }

  return cache;
}

/**
 * Helper function to get all mints that reference a specific oracle pubkey
 * Used for mapping oracle prices to all reserves that use that oracle
 * 
 * @param reserveCache - The reserve cache to search
 * @param oraclePubkey - Oracle public key as string
 * @returns Array of mint addresses (strings) that use this oracle
 */
export function getMintsByOracle(
  reserveCache: ReserveCache,
  oraclePubkey: string
): string[] {
  const result: string[] = [];
  for (const [mint, reserve] of reserveCache.entries()) {
    // Check if any oracle in the reserve matches (compare as PublicKey first for efficiency)
    const hasOracle = reserve.oraclePubkeys.some(pk => pk.toString() === oraclePubkey);
    if (hasOracle) {
      result.push(mint);
    }
  }
  return result;
}
