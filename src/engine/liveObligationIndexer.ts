import { PublicKey, Connection } from "@solana/web3.js";
import { Buffer } from "buffer";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { logger } from "../observability/logger.js";
import { decodeObligation } from "../kamino/decoder.js";
import { DecodedObligation } from "../kamino/types.js";
import { createYellowstoneClient, YellowstoneClientInstance } from "../yellowstone/client.js";
import { subscribeToAccounts, YellowstoneSubscriptionHandle } from "../yellowstone/subscribeAccounts.js";
import { CommitmentLevel, SubscribeRequestFilterAccounts } from "@triton-one/yellowstone-grpc";
import { withRetry } from "../utils/retry.js";
import { anchorDiscriminator } from "../kamino/decode/discriminator.js";

/**
 * Live Obligation Indexer - Production-grade indexer with Yellowstone gRPC streaming
 * 
 * Features:
 * - RPC bootstrap: populates cache from snapshot on startup
 * - Streams real-time updates via Yellowstone gRPC
 * - Maintains in-memory Map of decoded obligations
 * - Automatic reconnection with exponential backoff
 * - Inactivity watchdog for stream health monitoring
 * - Slot-based ordering (ignores stale updates)
 * - Circuit breaker on repeated decode failures
 * - Structured logging throughout
 */

export interface LiveObligationIndexerConfig {
  yellowstoneUrl: string;
  yellowstoneToken: string;
  programId: PublicKey;
  rpcUrl: string; // Required for bootstrap
  obligationsFilePath?: string;
  filters?: SubscribeRequestFilterAccounts["filters"];
  commitment?: CommitmentLevel;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  reconnectBackoffFactor?: number;
  bootstrapBatchSize?: number; // Default 100
  bootstrapConcurrency?: number; // Default 1
  inactivityTimeoutSeconds?: number; // Default 15
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
  private activeSub: YellowstoneSubscriptionHandle | null = null;
  private isRunning = false;
  private shouldReconnect = true;
  private currentReconnectAttempt = 0;
  private reconnectCount = 0;
  
  // Circuit breaker for decode failures
  private decodeFailures: number[] = []; // timestamps of failures
  private readonly CIRCUIT_BREAKER_THRESHOLD = 50;
  private readonly CIRCUIT_BREAKER_WINDOW_MS = 30000; // 30 seconds

  constructor(config: LiveObligationIndexerConfig) {
    this.config = {
      obligationsFilePath: config.obligationsFilePath || join(process.cwd(), "data", "obligations.jsonl"),
      filters: config.filters || [],
      commitment: config.commitment || CommitmentLevel.CONFIRMED,
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
      reconnectDelayMs: config.reconnectDelayMs || 1000,
      reconnectBackoffFactor: config.reconnectBackoffFactor || 2,
      bootstrapBatchSize: config.bootstrapBatchSize || 100,
      bootstrapConcurrency: config.bootstrapConcurrency || 1,
      inactivityTimeoutSeconds: config.inactivityTimeoutSeconds || 15,
      ...config,
    };
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
   * Bootstrap cache from RPC using getMultipleAccountsInfo
   */
  private async bootstrapCacheFromRpc(): Promise<void> {
    if (this.obligationPubkeys.size === 0) {
      logger.info("No obligation pubkeys to bootstrap");
      return;
    }

    logger.info(
      { 
        pubkeyCount: this.obligationPubkeys.size,
        batchSize: this.config.bootstrapBatchSize,
        rpcUrl: this.config.rpcUrl 
      },
      "Starting RPC bootstrap"
    );

    const connection = new Connection(this.config.rpcUrl, "confirmed");
    const pubkeysArray = Array.from(this.obligationPubkeys);
    const batches: PublicKey[][] = [];

    // Split into batches
    for (let i = 0; i < pubkeysArray.length; i += this.config.bootstrapBatchSize) {
      const batch = pubkeysArray
        .slice(i, i + this.config.bootstrapBatchSize)
        .map(pkStr => new PublicKey(pkStr));
      batches.push(batch);
    }

    logger.info({ batchCount: batches.length }, "Processing bootstrap batches");

    let successCount = 0;
    let missingCount = 0;
    let failedCount = 0;

    // Process batches with limited concurrency
    for (let i = 0; i < batches.length; i += this.config.bootstrapConcurrency) {
      const concurrentBatches = batches.slice(i, i + this.config.bootstrapConcurrency);
      
      // Process batches with limited concurrency - results are not used but kept for completion
      await Promise.allSettled(
        concurrentBatches.map(async (batch) => {
          try {
            const accounts = await connection.getMultipleAccountsInfo(batch, "confirmed");
            
            for (let j = 0; j < batch.length; j++) {
              const pubkey = batch[j];
              const account = accounts[j];
              
              if (!account) {
                missingCount++;
                logger.debug({ pubkey: pubkey.toString() }, "Account not found during bootstrap");
                continue;
              }

              try {
                const decoded = decodeObligation(Buffer.from(account.data), pubkey);
                const pubkeyStr = pubkey.toString();
                
                // Use slot 0n for bootstrap data (lowest priority)
                this.cache.set(pubkeyStr, {
                  decoded,
                  lastUpdated: Date.now(),
                  slot: 0n,
                });
                
                successCount++;
              } catch (decodeErr) {
                failedCount++;
                logger.warn(
                  { pubkey: pubkey.toString(), error: decodeErr },
                  "Failed to decode account during bootstrap"
                );
                // Note: Bootstrap decode failures are not tracked by circuit breaker
                // because they represent stale/missing data at startup, not ongoing corruption
              }
            }
          } catch (error) {
            logger.error({ error }, "Failed to fetch batch during bootstrap");
            failedCount += batch.length;
          }
        })
      );
    }

    logger.info(
      { 
        successCount, 
        missingCount, 
        failedCount,
        totalProcessed: successCount + missingCount + failedCount 
      },
      "RPC bootstrap completed"
    );
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
      
      // Update cache only if this is newer data (higher slot) or same slot but newer timestamp
      const existing = this.cache.get(pubkeyStr);
      
      // Ignore updates with strictly lower slot (includes bootstrap slot=0n)
      // For equal slots, accept the update (handles multiple updates in same slot)
      if (existing && slot < existing.slot) {
        logger.debug(
          { 
            pubkey: pubkeyStr, 
            newSlot: slot.toString(), 
            existingSlot: existing.slot.toString() 
          }, 
          "Skipped stale update (lower slot)"
        );
        return;
      }

      // Accept the update
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
    } catch (error) {
      logger.error(
        { pubkey: pubkeyStr, slot: slot.toString(), error },
        "Failed to decode obligation account"
      );
      
      // Track decode failure for circuit breaker
      this.trackDecodeFailure();
    }
  };

  /**
   * Track a decode failure and check circuit breaker
   */
  private trackDecodeFailure(): void {
    const now = Date.now();
    this.decodeFailures.push(now);
    
    // Remove old failures outside the window
    this.decodeFailures = this.decodeFailures.filter(
      timestamp => now - timestamp < this.CIRCUIT_BREAKER_WINDOW_MS
    );
    
    // Check if we've exceeded the threshold
    if (this.decodeFailures.length >= this.CIRCUIT_BREAKER_THRESHOLD) {
      logger.fatal(
        { 
          failureCount: this.decodeFailures.length,
          windowSeconds: this.CIRCUIT_BREAKER_WINDOW_MS / 1000,
          threshold: this.CIRCUIT_BREAKER_THRESHOLD
        },
        "Circuit breaker triggered: too many decode failures, stopping indexer"
      );
      
      // Stop the indexer gracefully
      this.shouldReconnect = false;
      this.isRunning = false;
      
      // Close active subscription if exists
      if (this.activeSub) {
        this.activeSub.close();
      }
    }
  }

  /**
   * Cleanup the current client if it exists
   */
  private cleanupClient(): void {
    if (this.client) {
      try {
        // The Yellowstone client doesn't have an explicit close method in the interface,
        // but we can clear the reference to allow garbage collection
        this.client = null;
        logger.debug("Cleaned up old Yellowstone client");
      } catch (error) {
        logger.warn({ error }, "Error during client cleanup");
      }
    }
  }

  /**
   * Start the subscription with automatic reconnection
   */
  private async startSubscription(): Promise<void> {
    while (this.shouldReconnect && this.isRunning) {
      try {
        // Cleanup old client if it exists
        this.cleanupClient();

        // Initialize client
        this.client = await this.initializeClient();
        this.currentReconnectAttempt = 0; // Reset on successful connection

        logger.info(
          {
            programId: this.config.programId.toString(),
            filtersCount: this.config.filters.length,
            commitment: CommitmentLevel[this.config.commitment],
            inactivityTimeoutSeconds: this.config.inactivityTimeoutSeconds,
          },
          "Starting Yellowstone subscription"
        );

        // Start subscription - get handle
        this.activeSub = await subscribeToAccounts(
          this.client,
          this.config.programId,
          this.config.filters,
          this.handleAccountUpdate,
          this.config.commitment,
          this.config.inactivityTimeoutSeconds
        );

        // Wait for the subscription to complete
        await this.activeSub.done;

        // If we get here, stream ended normally
        logger.info("Yellowstone subscription ended normally");

        // If we should reconnect and are still running, try again
        if (this.shouldReconnect && this.isRunning) {
          this.reconnectCount++;
          logger.info({ reconnectCount: this.reconnectCount }, "Stream ended, will attempt to reconnect");
          await this.delay(this.config.reconnectDelayMs);
        }
      } catch (error) {
        // Check if this is an InvalidArg error (configuration/request validation error)
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isInvalidArg = errorMessage.includes("InvalidArg") || 
                            errorMessage.includes("invalid type") ||
                            (error && typeof error === "object" && "code" in error && error.code === 3);
        
        if (isInvalidArg) {
          logger.fatal(
            { error, errorMessage },
            "FATAL: Invalid request configuration (InvalidArg). This is a bug in filter setup. Stopping indexer."
          );
          this.shouldReconnect = false;
          this.isRunning = false;
          throw error; // Propagate error to exit with non-zero code
        }
        
        logger.error({ error }, "Yellowstone subscription error");

        // Check if we should attempt to reconnect
        if (this.shouldReconnect && this.isRunning) {
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

    // Cleanup client when done
    this.cleanupClient();
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

    // Auto-inject obligation discriminator filter if filters are empty or undefined
    // This ensures the indexer is safe by default and doesn't subscribe to all program accounts
    if (!this.config.filters || this.config.filters.length === 0) {
      const obligationDiscriminator = anchorDiscriminator("Obligation");
      this.config.filters = [
        {
          memcmp: {
            offset: 0n, // Use bigint for u64 compatibility with Yellowstone gRPC
            base64: obligationDiscriminator.toString("base64"),
          },
        },
      ] as any; // Type assertion needed for filter type compatibility
      
      logger.info(
        { discriminator: obligationDiscriminator.toString("hex") },
        "Auto-injected Obligation discriminator filter for safe subscription"
      );
    }

    // Load initial snapshot
    this.loadObligationPubkeys();

    // Bootstrap cache from RPC
    await this.bootstrapCacheFromRpc();

    logger.info(
      { 
        snapshotSize: this.obligationPubkeys.size,
        cacheSize: this.cache.size 
      },
      "Bootstrap complete, starting Yellowstone subscription"
    );

    // Start subscription in background (don't await here, let it reconnect)
    this.startSubscription().catch(error => {
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

    // Close the active subscription if it exists
    if (this.activeSub) {
      this.activeSub.close();
      
      // Wait for subscription to finish with timeout guard
      try {
        await Promise.race([
          this.activeSub.done.catch(() => {}), // Ignore errors during shutdown
          this.delay(5000), // 5 second timeout
        ]);
      } catch (error) {
        logger.warn({ error }, "Error while waiting for subscription to stop");
      }
      
      this.activeSub = null;
    }

    // Cleanup client
    this.cleanupClient();

    logger.info(
      { 
        cacheSize: this.cache.size,
        knownPubkeys: this.obligationPubkeys.size,
        reconnectCount: this.reconnectCount
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
    reconnectCount: number;
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
      reconnectCount: this.reconnectCount,
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
