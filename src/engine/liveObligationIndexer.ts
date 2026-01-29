import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { logger } from "../observability/logger.js";
import { decodeObligation } from "../kamino/decoder.js";
import { DecodedObligation } from "../kamino/types.js";
import { createYellowstoneClient, YellowstoneClientInstance } from "../yellowstone/client.js";
import { subscribeToAccounts } from "../yellowstone/subscribeAccounts.js";
import { CommitmentLevel, SubscribeRequestFilterAccounts } from "@triton-one/yellowstone-grpc";
import { withRetry } from "../utils/retry.js";

/**
 * Live Obligation Indexer - Production-grade indexer with Yellowstone gRPC streaming
 * 
 * Features:
 * - Loads initial snapshot from data/obligations.jsonl
 * - Streams real-time updates via Yellowstone gRPC
 * - Maintains in-memory Map of decoded obligations
 * - Automatic reconnection with exponential backoff
 * - Clean shutdown handling
 * - Structured logging throughout
 */

export interface LiveObligationIndexerConfig {
  yellowstoneUrl: string;
  yellowstoneToken: string;
  programId: PublicKey;
  obligationsFilePath?: string;
  filters?: SubscribeRequestFilterAccounts["filters"];
  commitment?: CommitmentLevel;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  reconnectBackoffFactor?: number;
}

interface ObligationEntry {
  decoded: DecodedObligation;
  lastUpdated: number;
  slot: bigint;
}

export class LiveObligationIndexer {
  private config: Required<LiveObligationIndexerConfig>;
  private cache: Map<string, ObligationEntry> = new Map();
  private obligationPubkeys: Set<string> = new Set();
  private client: YellowstoneClientInstance | null = null;
  private isRunning = false;
  private shouldReconnect = true;
  private currentReconnectAttempt = 0;
  private subscriptionPromise: Promise<void> | null = null;
  private shutdownSignalReceived = false;

  constructor(config: LiveObligationIndexerConfig) {
    this.config = {
      obligationsFilePath: config.obligationsFilePath || join(process.cwd(), "data", "obligations.jsonl"),
      filters: config.filters || [],
      commitment: config.commitment || CommitmentLevel.CONFIRMED,
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
      reconnectDelayMs: config.reconnectDelayMs || 1000,
      reconnectBackoffFactor: config.reconnectBackoffFactor || 2,
      ...config,
    };
  }

  /**
   * Setup handlers for graceful shutdown
   */
  private setupShutdownHandlers(): void {
    const shutdownHandler = async (signal: string) => {
      if (this.shutdownSignalReceived) {
        return; // Already shutting down
      }
      this.shutdownSignalReceived = true;
      logger.info({ signal }, "Shutdown signal received");
      await this.stop();
      process.exit(0);
    };

    process.on("SIGINT", () => shutdownHandler("SIGINT"));
    process.on("SIGTERM", () => shutdownHandler("SIGTERM"));
  }

  /**
   * Load obligation pubkeys from the jsonl snapshot file
   */
  private loadObligationPubkeys(): void {
    if (!existsSync(this.config.obligationsFilePath)) {
      logger.warn({ path: this.config.obligationsFilePath }, "Obligations snapshot file not found");
      return;
    }

    try {
      const content = readFileSync(this.config.obligationsFilePath, "utf-8");
      const lines = content.trim().split("\n").filter(line => line.trim());
      
      let validCount = 0;
      for (const line of lines) {
        const pubkeyStr = line.trim();
        try {
          // Validate the pubkey format
          new PublicKey(pubkeyStr);
          this.obligationPubkeys.add(pubkeyStr);
          validCount++;
        } catch (error) {
          logger.warn({ pubkey: pubkeyStr, error }, "Invalid pubkey in snapshot file, skipping");
        }
      }

      logger.info(
        { 
          path: this.config.obligationsFilePath, 
          total: lines.length,
          valid: validCount,
          invalid: lines.length - validCount
        }, 
        "Loaded obligation pubkeys from snapshot"
      );
    } catch (error) {
      logger.error({ path: this.config.obligationsFilePath, error }, "Failed to load snapshot file");
    }
  }

  /**
   * Initialize Yellowstone client with retry logic
   */
  private async initializeClient(): Promise<YellowstoneClientInstance> {
    return withRetry(
      async () => {
        logger.info({ url: this.config.yellowstoneUrl }, "Connecting to Yellowstone gRPC");
        const client = await createYellowstoneClient(
          this.config.yellowstoneUrl,
          this.config.yellowstoneToken
        );
        logger.info("Yellowstone gRPC client connected");
        return client;
      },
      {
        maxRetries: 3,
        delayMs: 1000,
        backoffFactor: 2,
      }
    );
  }

  /**
   * Handle incoming account update
   */
  private handleAccountUpdate = async (
    pubkey: PublicKey,
    accountData: Buffer,
    slot: bigint
  ): Promise<void> => {
    const pubkeyStr = pubkey.toString();

    try {
      // Decode the obligation account
      const decoded = decodeObligation(accountData, pubkey);
      
      // Update cache
      const existing = this.cache.get(pubkeyStr);
      
      // Only update if this is newer data (higher slot)
      if (!existing || slot >= existing.slot) {
        this.cache.set(pubkeyStr, {
          decoded,
          lastUpdated: Date.now(),
          slot,
        });

        // Add to known pubkeys set
        this.obligationPubkeys.add(pubkeyStr);

        logger.debug(
          { 
            pubkey: pubkeyStr, 
            slot: slot.toString(),
            depositsCount: decoded.deposits.length,
            borrowsCount: decoded.borrows.length,
          }, 
          "Updated obligation in cache"
        );
      } else {
        logger.debug(
          { 
            pubkey: pubkeyStr, 
            newSlot: slot.toString(), 
            existingSlot: existing.slot.toString() 
          }, 
          "Skipped stale update (lower slot)"
        );
      }
    } catch (error) {
      logger.error(
        { pubkey: pubkeyStr, slot: slot.toString(), error },
        "Failed to decode obligation account"
      );
    }
  };

  /**
   * Start the subscription with automatic reconnection
   */
  private async startSubscription(): Promise<void> {
    while (this.shouldReconnect && !this.shutdownSignalReceived) {
      try {
        // Initialize client
        this.client = await this.initializeClient();
        this.currentReconnectAttempt = 0; // Reset on successful connection

        logger.info(
          {
            programId: this.config.programId.toString(),
            filtersCount: this.config.filters.length,
            commitment: CommitmentLevel[this.config.commitment],
          },
          "Starting Yellowstone subscription"
        );

        // Start subscription - this will run until stream ends or errors
        await subscribeToAccounts(
          this.client,
          this.config.programId,
          this.config.filters,
          this.handleAccountUpdate,
          this.config.commitment
        );

        // If we get here, stream ended normally
        logger.info("Yellowstone subscription ended normally");

        // If we should reconnect and haven't been told to stop, try again
        if (this.shouldReconnect && !this.shutdownSignalReceived) {
          logger.info("Stream ended, will attempt to reconnect");
          await this.delay(this.config.reconnectDelayMs);
        }
      } catch (error) {
        logger.error({ error }, "Yellowstone subscription error");

        // Check if we should attempt to reconnect
        if (this.shouldReconnect && !this.shutdownSignalReceived) {
          this.currentReconnectAttempt++;

          if (this.currentReconnectAttempt <= this.config.maxReconnectAttempts) {
            const delay = this.config.reconnectDelayMs * 
              Math.pow(this.config.reconnectBackoffFactor, this.currentReconnectAttempt - 1);
            
            logger.info(
              {
                attempt: this.currentReconnectAttempt,
                maxAttempts: this.config.maxReconnectAttempts,
                delayMs: delay,
              },
              "Attempting to reconnect to Yellowstone"
            );

            await this.delay(delay);
          } else {
            logger.error(
              { attempts: this.currentReconnectAttempt },
              "Max reconnection attempts reached, stopping indexer"
            );
            this.shouldReconnect = false;
            this.isRunning = false;
            break;
          }
        }
      }
    }
  }

  /**
   * Helper to delay execution
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Start the live indexer
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Live indexer already running");
      return;
    }

    logger.info("Starting live obligation indexer");
    this.isRunning = true;
    this.shouldReconnect = true;
    this.shutdownSignalReceived = false;

    // Setup clean shutdown handlers (only when starting)
    this.setupShutdownHandlers();

    // Load initial snapshot
    this.loadObligationPubkeys();

    logger.info(
      { 
        snapshotSize: this.obligationPubkeys.size,
        cacheSize: this.cache.size 
      },
      "Initial snapshot loaded, starting Yellowstone subscription"
    );

    // Start subscription in background (don't await here)
    this.subscriptionPromise = this.startSubscription().catch(error => {
      logger.error({ error }, "Fatal error in subscription loop");
      this.isRunning = false;
    });
  }

  /**
   * Stop the live indexer
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.debug("Live indexer not running");
      return;
    }

    logger.info("Stopping live obligation indexer");
    this.shouldReconnect = false;
    this.isRunning = false;

    // Wait for subscription to finish if it's running
    if (this.subscriptionPromise) {
      try {
        await Promise.race([
          this.subscriptionPromise,
          this.delay(5000), // 5 second timeout
        ]);
      } catch (error) {
        logger.warn({ error }, "Error while waiting for subscription to stop");
      }
    }

    logger.info(
      { 
        cacheSize: this.cache.size,
        knownPubkeys: this.obligationPubkeys.size 
      },
      "Live obligation indexer stopped"
    );
  }

  /**
   * Get a decoded obligation from the cache
   */
  public getObligation(pubkey: string): DecodedObligation | null {
    const entry = this.cache.get(pubkey);
    return entry ? entry.decoded : null;
  }

  /**
   * Get all cached obligations
   */
  public getAllObligations(): DecodedObligation[] {
    return Array.from(this.cache.values()).map(entry => entry.decoded);
  }

  /**
   * Get cache statistics
   */
  public getStats(): {
    isRunning: boolean;
    cacheSize: number;
    knownPubkeys: number;
    lastUpdate: number | null;
    oldestSlot: string | null;
    newestSlot: string | null;
  } {
    const entries = Array.from(this.cache.values());
    const lastUpdateTimes = entries.map(e => e.lastUpdated);
    const slots = entries.map(e => e.slot);

    return {
      isRunning: this.isRunning,
      cacheSize: this.cache.size,
      knownPubkeys: this.obligationPubkeys.size,
      lastUpdate: lastUpdateTimes.length > 0 ? Math.max(...lastUpdateTimes) : null,
      oldestSlot: slots.length > 0 ? slots.reduce((a, b) => (a < b ? a : b)).toString() : null,
      newestSlot: slots.length > 0 ? slots.reduce((a, b) => (a > b ? a : b)).toString() : null,
    };
  }

  /**
   * Check if the indexer is currently running
   */
  public isIndexerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Force reload the snapshot file (without stopping the stream)
   */
  public reloadSnapshot(): void {
    logger.info("Reloading obligation snapshot");
    this.loadObligationPubkeys();
  }
}
