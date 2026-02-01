import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import bs58 from "bs58";
import { logger } from "../observability/logger.js";
import { decodeReserve, setReserveMintCache } from "../kamino/decoder.js";
import { anchorDiscriminator } from "../kamino/decode/discriminator.js";

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
  /** Available liquidity amount (raw, not adjusted for decimals) */
  availableAmount: bigint;
  /** 
   * Cumulative borrow rate (big scaled fraction / BSF)
   * Used to convert borrowedAmountSf to actual token amounts
   */
  cumulativeBorrowRate: bigint;
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
  /** Scope price chain index (0-511) for multi-chain Scope oracles, null if not using Scope */
  scopePriceChain: number | null;
}

/**
 * Reserve cache mapping liquidity mint to reserve data
 */
export type ReserveCache = Map<string, ReserveCacheEntry>;

/**
 * Scope oracle chain map - maps Scope oracle pubkey to priceChain index
 * This is populated during reserve loading and used during oracle decoding
 * to select the correct price from multi-chain Scope oracles
 */
export const scopeOracleChainMap = new Map<string, number>();

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
 * @returns Map of liquidity mint (as string) to ReserveCacheEntry
 */
export async function loadReserves(
  connection: Connection,
  marketPubkey: PublicKey
): Promise<ReserveCache> {
  logger.info(
    { market: marketPubkey.toString() },
    "Loading reserves for market..."
  );

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
  const cache = new Map<string, ReserveCacheEntry>();
  let decodedCount = 0;
  let matchedCount = 0;

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

      matchedCount++;

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
      
      // If this reserve uses Scope, track the oracle→chain mapping
      if (decoded.scopePriceChain !== null) {
        // Find the Scope oracle pubkey (it should be in the oraclePubkeys array)
        for (const oraclePk of oraclePubkeys) {
          const oracleStr = oraclePk.toString();
          // Check if this might be a Scope oracle by checking if it's already in the map
          // or by checking the owner later during oracle loading
          // For now, we'll map all oracles if scopePriceChain is set
          // The oracle loader will determine which ones are actually Scope oracles
          if (!scopeOracleChainMap.has(oracleStr)) {
            scopeOracleChainMap.set(oracleStr, decoded.scopePriceChain);
            logger.debug(
              {
                reserve: pubkey.toString(),
                oracle: oracleStr,
                priceChain: decoded.scopePriceChain,
              },
              "Mapped Scope oracle to price chain"
            );
          }
        }
      }

      // Create cache entry
      const cacheEntry: ReserveCacheEntry = {
        reservePubkey: pubkey,
        availableAmount: BigInt(decoded.availableLiquidity),
        cumulativeBorrowRate: BigInt(decoded.cumulativeBorrowRate),
        loanToValue: decoded.loanToValueRatio,
        liquidationThreshold: decoded.liquidationThreshold,
        liquidationBonus: decoded.liquidationBonus,
        borrowFactor: decoded.borrowFactor,
        oraclePubkeys,
        liquidityDecimals: decoded.liquidityDecimals,
        collateralDecimals: decoded.collateralDecimals,
        scopePriceChain: decoded.scopePriceChain,
      };

      // Store in cache keyed by liquidity mint
      cache.set(decoded.liquidityMint, cacheEntry);

      // Populate setReserveMintCache for obligation decoding
      setReserveMintCache(pubkey.toString(), decoded.liquidityMint);

      logger.debug(
        {
          reserve: pubkey.toString(),
          mint: decoded.liquidityMint,
          availableAmount: cacheEntry.availableAmount.toString(),
          oracleCount: oraclePubkeys.length,
        },
        "Cached reserve"
      );
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
      cached: cache.size,
    },
    "Reserve cache loaded successfully"
  );

  // Validate minimum expected reserves
  // Ensure we have at least 5 reserves for a healthy market
  const MIN_EXPECTED_RESERVES = 5;
  if (cache.size < MIN_EXPECTED_RESERVES) {
    logger.warn(
      { cached: cache.size, expected: MIN_EXPECTED_RESERVES },
      "WARNING: Fewer reserves cached than expected - may indicate configuration issue, small market, or RPC problem"
    );
  }

  return cache;
}
