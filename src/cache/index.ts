import { Connection, PublicKey } from "@solana/web3.js";
import { logger } from "../observability/logger.js";
import {
  loadReserves,
  type ReserveCache,
  type ReserveCacheEntry,
} from "./reserveCache.js";
import {
  loadOracles,
  type OracleCache,
  type OraclePriceData,
} from "./oracleCache.js";

/**
 * Combined cache result containing both reserve and oracle data
 */
export interface CacheResult {
  /** Reserve cache keyed by liquidity mint */
  reserves: ReserveCache;
  /** Oracle cache keyed by mint */
  oracles: OracleCache;
}

/**
 * Loads both reserve and oracle caches for a given Kamino market
 * This is the main entry point for initializing caches at bot startup.
 *
 * @param connection - Solana RPC connection
 * @param marketPubkey - Kamino lending market public key
 * @returns Combined cache result with reserves and oracles
 */
export async function loadMarketCaches(
  connection: Connection,
  marketPubkey: PublicKey
): Promise<CacheResult> {
  logger.info(
    { market: marketPubkey.toString() },
    "Loading market caches (reserves + oracles)..."
  );

  const startTime = Date.now();

  // Load reserves first
  const reserves = await loadReserves(connection, marketPubkey);

  // Load oracles using the reserve cache
  const oracles = await loadOracles(connection, reserves);

  const elapsed = Date.now() - startTime;

  logger.info(
    {
      market: marketPubkey.toString(),
      reserves: reserves.size,
      oracles: oracles.size,
      elapsedMs: elapsed,
    },
    "Market caches loaded successfully"
  );

  return {
    reserves,
    oracles,
  };
}

// Re-export types for convenience
export type { ReserveCache, ReserveCacheEntry, OracleCache, OraclePriceData };
export { loadReserves, loadOracles };
