import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { logger } from "../observability/logger.js";
import { decodeObligation } from "../kamino/decoder.js";
import { DecodedObligation } from "../kamino/types.js";

/**
 * Obligation Indexer - builds and maintains an in-memory cache of decoded obligations
 * 
 * Input: data/obligations.jsonl (one pubkey per line)
 * Behavior: Polls RPC using getMultipleAccountsInfo in batches
 * No websocket support yet - uses interval-based polling
 */

interface ObligationCache {
  [pubkey: string]: {
    decoded: DecodedObligation;
    lastUpdated: number;
  };
}

export interface ObligationIndexerConfig {
  connection: Connection;
  obligationsFilePath?: string;
  batchSize?: number;
  pollIntervalMs?: number;
}

export class ObligationIndexer {
  private connection: Connection;
  private obligationsFilePath: string;
  private batchSize: number;
  private pollIntervalMs: number;
  private cache: ObligationCache = {};
  private obligationPubkeys: PublicKey[] = [];
  private intervalHandle: NodeJS.Timeout | null = null;
  private isFetching: boolean = false;

  constructor(config: ObligationIndexerConfig) {
    this.connection = config.connection;
    this.obligationsFilePath = config.obligationsFilePath || join(process.cwd(), "data", "obligations.jsonl");
    this.batchSize = config.batchSize || 100;
    this.pollIntervalMs = config.pollIntervalMs || 30000; // 30 seconds default
  }

  /**
   * Load obligation pubkeys from the jsonl file
   */
  private loadObligationPubkeys(): void {
    if (!existsSync(this.obligationsFilePath)) {
      logger.warn({ path: this.obligationsFilePath }, "Obligations file not found");
      this.obligationPubkeys = [];
      return;
    }

    try {
      const content = readFileSync(this.obligationsFilePath, "utf-8");
      const lines = content.trim().split("\n").filter(line => line.trim());
      
      this.obligationPubkeys = lines.map(line => {
        const pubkeyStr = line.trim();
        try {
          return new PublicKey(pubkeyStr);
        } catch (error) {
          logger.warn({ pubkey: pubkeyStr, error }, "Invalid pubkey in obligations file");
          return null;
        }
      }).filter((pk): pk is PublicKey => pk !== null);

      logger.info(
        { 
          path: this.obligationsFilePath, 
          count: this.obligationPubkeys.length 
        }, 
        "Loaded obligation pubkeys"
      );
    } catch (error) {
      logger.error({ path: this.obligationsFilePath, error }, "Failed to load obligations file");
      this.obligationPubkeys = [];
    }
  }

  /**
   * Fetch and decode obligations in batches
   */
  private async fetchAndDecodeObligations(): Promise<void> {
    if (this.obligationPubkeys.length === 0) {
      logger.debug("No obligations to fetch");
      return;
    }

    // Prevent overlapping fetches
    if (this.isFetching) {
      logger.debug("Fetch already in progress, skipping");
      return;
    }

    this.isFetching = true;

    try {
      logger.debug(
        { count: this.obligationPubkeys.length, batchSize: this.batchSize },
        "Starting obligation fetch"
      );

      // Process in batches
      for (let i = 0; i < this.obligationPubkeys.length; i += this.batchSize) {
        const batch = this.obligationPubkeys.slice(i, i + this.batchSize);
        
        try {
          const accounts = await this.connection.getMultipleAccountsInfo(batch);
          
          for (const [j, accountInfo] of accounts.entries()) {
            const pubkey = batch[j];

            if (!accountInfo || !accountInfo.data) {
              logger.debug({ pubkey: pubkey.toString() }, "Account not found or has no data");
              continue;
            }

            try {
              const decoded = decodeObligation(accountInfo.data, pubkey);
              this.cache[pubkey.toString()] = {
                decoded,
                lastUpdated: Date.now(),
              };
            } catch (error) {
              logger.warn(
                { pubkey: pubkey.toString(), error },
                "Failed to decode obligation"
              );
            }
          }

          logger.debug(
            { 
              batchStart: i, 
              batchEnd: i + batch.length,
              successCount: accounts.filter(a => a !== null).length
            },
            "Batch processed"
          );
        } catch (error) {
          logger.error(
            { batchStart: i, batchEnd: i + this.batchSize, error },
            "Failed to fetch batch"
          );
        }
      }

      logger.info(
        { cacheSize: Object.keys(this.cache).length },
        "Obligation cache updated"
      );
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Start the indexer - loads pubkeys and begins polling
   */
  public async start(): Promise<void> {
    logger.info("Starting obligation indexer");
    
    // Load pubkeys from file
    this.loadObligationPubkeys();

    if (this.obligationPubkeys.length === 0) {
      logger.warn("No obligations to index, skipping polling");
      return;
    }

    // Do initial fetch
    await this.fetchAndDecodeObligations();

    // Start polling
    this.intervalHandle = setInterval(async () => {
      try {
        await this.fetchAndDecodeObligations();
      } catch (error) {
        logger.error({ error }, "Error in polling interval");
      }
    }, this.pollIntervalMs);

    logger.info(
      { pollIntervalMs: this.pollIntervalMs },
      "Obligation indexer started"
    );
  }

  /**
   * Stop the indexer
   */
  public stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    logger.info("Obligation indexer stopped");
  }

  /**
   * Get a decoded obligation from the cache
   */
  public getObligation(pubkey: string): DecodedObligation | null {
    const cached = this.cache[pubkey];
    return cached ? cached.decoded : null;
  }

  /**
   * Get all cached obligations
   */
  public getAllObligations(): DecodedObligation[] {
    return Object.values(this.cache).map(c => c.decoded);
  }

  /**
   * Get cache statistics
   */
  public getStats(): { totalObligations: number; cacheSize: number; lastUpdate: number | null } {
    const cacheEntries = Object.values(this.cache);
    const lastUpdateTimes = cacheEntries.map(c => c.lastUpdated);
    
    return {
      totalObligations: this.obligationPubkeys.length,
      cacheSize: cacheEntries.length,
      lastUpdate: lastUpdateTimes.length > 0 
        ? lastUpdateTimes.reduce((a, b) => Math.max(a, b), -Infinity)
        : null,
    };
  }

  /**
   * Reload obligation pubkeys from file (useful if file is updated)
   */
  public reload(): void {
    logger.info("Reloading obligation pubkeys");
    this.loadObligationPubkeys();
  }
}
