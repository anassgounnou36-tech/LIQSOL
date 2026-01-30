import {
  SubscribeUpdate,
  SubscribeRequestFilterAccounts,
  CommitmentLevel,
} from "@triton-one/yellowstone-grpc";
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { Duplex } from "stream";
import { logger } from "../observability/logger.js";
import type { YellowstoneClientInstance } from "./client.js";

/**
 * Normalize filters to ensure proper types for gRPC serialization:
 * - memcmp.offset must be a JS number (matching "old bot" working behavior)
 * - memcmp.bytes (Buffer) should be converted to base64 string
 */
function normalizeFilters(filters: any[]): any[] {
  return filters.map((f) => {
    if (!f?.memcmp) return f;

    // Convert offset to JS number (matching old bot behavior)
    let offset = f.memcmp.offset;
    if (typeof offset === "string") offset = Number(offset);
    if (typeof offset === "bigint") offset = Number(offset);

    // Default to 0 if not a finite number
    if (typeof offset !== "number" || !Number.isFinite(offset)) offset = 0;
    
    // Force integer + non-negative
    offset = Math.max(0, Math.floor(offset));

    const memcmp: any = { ...f.memcmp, offset };

    // Prefer base64 string over raw bytes
    if (Buffer.isBuffer(memcmp.bytes)) {
      memcmp.base64 = memcmp.bytes.toString("base64");
      delete memcmp.bytes;
    }

    return { ...f, memcmp };
  });
}

/**
 * Callback for processing account updates
 */
export type AccountUpdateCallback = (
  pubkey: PublicKey,
  accountData: Buffer,
  slot: bigint
) => void | Promise<void>;

/**
 * Yellowstone subscription handle for production-safe stream management
 */
export interface YellowstoneSubscriptionHandle {
  /**
   * Close the subscription stream (idempotent)
   */
  close(): void;
  
  /**
   * Promise that resolves when stream ends cleanly, rejects on error
   */
  done: Promise<void>;
}

/**
 * Subscribe to accounts owned by a program with optional filters
 * 
 * @param client - Connected Yellowstone gRPC client
 * @param programId - Program ID whose accounts to subscribe to
 * @param filters - Array of account filters (memcmp, datasize, etc.)
 * @param onAccountUpdate - Callback for each account update
 * @param commitment - Commitment level (defaults to confirmed)
 * @param inactivityTimeoutSeconds - Timeout in seconds for inactivity watchdog (defaults to 15)
 * @returns YellowstoneSubscriptionHandle with close() and done promise
 */
export async function subscribeToAccounts(
  client: YellowstoneClientInstance,
  programId: PublicKey,
  filters: SubscribeRequestFilterAccounts["filters"],
  onAccountUpdate: AccountUpdateCallback,
  commitment: CommitmentLevel = CommitmentLevel.CONFIRMED,
  inactivityTimeoutSeconds = 15
): Promise<YellowstoneSubscriptionHandle> {
  logger.info(
    { programId: programId.toString(), filtersCount: filters.length },
    "Starting account subscription via Yellowstone gRPC"
  );

  // Normalize filters to ensure memcmp.offset is a JS number (old bot behavior)
  const normalizedFilters = normalizeFilters(filters as any[]);

  // Create subscription request in canonical "accounts map entry" form
  const request = {
    commitment,
    accounts: {
      obligations: {
        owner: [programId.toString()],
        filters: normalizedFilters,
      },
    },
    slots: {},
    accountsDataSlice: [],
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
  };

  // Debug logging: sanitized request structure (no token)
  logger.debug(
    {
      requestKeys: Object.keys(request),
      accountsKeys: Object.keys(request.accounts),
      accountsEntry: {
        owner: request.accounts.obligations.owner,
        filtersCount: request.accounts.obligations.filters.length,
        filters: request.accounts.obligations.filters,
      },
    },
    "Yellowstone subscription request structure"
  );

  // Create the duplex stream for subscription
  const stream: Duplex = await client.subscribe();

  let accountCount = 0;
  let closeRequested = false;
  let settled = false;
  let inactivityTimeoutId: NodeJS.Timeout | null = null;
  let pingIntervalId: NodeJS.Timeout | null = null;

  // Helper to reset inactivity timeout
  const resetInactivityTimeout = () => {
    if (inactivityTimeoutId) {
      clearTimeout(inactivityTimeoutId);
    }
    
    inactivityTimeoutId = setTimeout(() => {
      if (closeRequested) return;
      logger.warn(
        { inactivityTimeoutSeconds },
        "Inactivity timeout reached - no data received, destroying stream"
      );
      stream.destroy(new Error("Inactivity timeout"));
    }, inactivityTimeoutSeconds * 1000);
  };

  // Helper to cleanup inactivity timeout
  const clearInactivityTimeout = () => {
    if (inactivityTimeoutId) {
      clearTimeout(inactivityTimeoutId);
      inactivityTimeoutId = null;
    }
  };

  // Helper to cleanup ping interval
  const clearPingInterval = () => {
    if (pingIntervalId) {
      clearInterval(pingIntervalId);
      pingIntervalId = null;
    }
  };

  // Start outbound ping loop to keep connection alive (fallback)
  // Send ping every 5 seconds to prevent silent disconnects
  // Note: Yellowstone ping is a boolean field, not an object
  pingIntervalId = setInterval(() => {
    if (closeRequested) return;
    try {
      stream.write({ ping: true });
      logger.debug("Sent outbound ping to Yellowstone gRPC");
    } catch (err) {
      logger.warn({ err }, "Failed to send outbound ping");
    }
  }, 5000);

  const donePromise = new Promise<void>((resolve, reject) => {
    // Helper to settle promise with resolve (guard against multiple settlements)
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      clearInactivityTimeout();
      clearPingInterval();
      resolve();
    };

    // Helper to settle promise with reject (guard against multiple settlements)
    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      clearInactivityTimeout();
      clearPingInterval();
      reject(err);
    };

    stream.on("data", async (data: SubscribeUpdate) => {
      // Reset inactivity timeout on any data (including pings)
      resetInactivityTimeout();

      // Handle account updates
      if (data.account) {
        const accountInfo = data.account.account;
        if (!accountInfo) {
          return;
        }

        try {
          // Convert Uint8Array to Buffer and PublicKey
          const pubkeyBytes = Buffer.from(accountInfo.pubkey);
          const pubkey = new PublicKey(pubkeyBytes);
          const accountData = Buffer.from(accountInfo.data);
          const slot = BigInt(data.account.slot);

          accountCount++;

          // Call the user-provided callback
          await onAccountUpdate(pubkey, accountData, slot);
        } catch (err) {
          logger.error({ err }, "Error processing account update");
        }
      }

      // Handle ping updates (keep-alive)
      if (data.ping) {
        logger.debug("Received ping from Yellowstone gRPC, sending reply");
        // Reply to server ping immediately to maintain connection
        // Note: Yellowstone ping is a boolean field, not an object
        try {
          stream.write({ ping: true });
        } catch (err) {
          logger.warn({ err }, "Failed to reply to server ping");
        }
      }
    });

    stream.on("error", (err: Error) => {
      logger.error({ err }, "Yellowstone gRPC stream error");
      settleReject(err);
    });

    stream.on("end", () => {
      logger.info({ accountCount }, "Yellowstone gRPC stream ended");
      settleResolve();
    });

    stream.on("close", () => {
      settleResolve();
    });

    // Write the subscription request to the stream
    stream.write(request);

    logger.info("Subscription request sent, waiting for account updates");
    
    // Start inactivity timeout
    resetInactivityTimeout();
  });

  // Return subscription handle
  return {
    close: () => {
      if (closeRequested) return;
      closeRequested = true;
      clearInactivityTimeout();
      clearPingInterval();
      stream.destroy();
      logger.debug("Subscription stream closed via handle.close()");
    },
    done: donePromise,
  };
}

/**
 * Subscribe and collect all accounts matching filters, then end subscription
 * 
 * This is useful for one-time snapshots where you want to:
 * 1. Subscribe to accounts
 * 2. Collect all existing accounts (startup=true)
 * 3. Stop once initial snapshot is complete
 * 
 * @param client - Connected Yellowstone gRPC client
 * @param programId - Program ID whose accounts to subscribe to
 * @param filters - Array of account filters (memcmp, datasize, etc.)
 * @param commitment - Commitment level (defaults to confirmed)
 * @param maxTimeoutSeconds - Maximum time to wait for snapshot (defaults to 45 seconds)
 * @param inactivityTimeoutSeconds - Maximum time without receiving data before timeout (defaults to 10 seconds)
 * @returns Promise that resolves with array of [pubkey, accountData, slot] tuples
 */
export async function snapshotAccounts(
  client: YellowstoneClientInstance,
  programId: PublicKey,
  filters: SubscribeRequestFilterAccounts["filters"],
  commitment: CommitmentLevel = CommitmentLevel.CONFIRMED,
  maxTimeoutSeconds = 45,
  inactivityTimeoutSeconds = 10
): Promise<Array<[PublicKey, Buffer, bigint]>> {
  logger.info(
    { programId: programId.toString(), filtersCount: filters.length },
    "Starting account snapshot via Yellowstone gRPC"
  );

  // Map to deduplicate accounts by pubkey
  const accountsMap = new Map<string, [PublicKey, Buffer, bigint]>();
  let startupAccountsCompleted = false;
  
  // Track startup completion for natural snapshot ending
  let sawStartup = false;
  let lastStartupAtMs = 0;
  const STARTUP_QUIET_MS = 8000; // Wait 8s after last startup message to prevent premature cutoffs

  // Normalize filters to ensure memcmp.offset is a JS number (old bot behavior)
  const normalizedFilters = normalizeFilters(filters as any[]);

  // Create subscription request in canonical "accounts map entry" form
  const request = {
    commitment,
    accounts: {
      obligations: {
        owner: [programId.toString()],
        filters: normalizedFilters,
      },
    },
    slots: {},
    accountsDataSlice: [],
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
  };

  // Debug logging: sanitized request structure (no token)
  logger.debug(
    {
      requestKeys: Object.keys(request),
      accountsKeys: Object.keys(request.accounts),
      accountsEntry: {
        owner: request.accounts.obligations.owner,
        filtersCount: request.accounts.obligations.filters.length,
        filters: request.accounts.obligations.filters,
      },
    },
    "Yellowstone snapshot request structure"
  );

  // Create the duplex stream for subscription
  const stream: Duplex = await client.subscribe();

  return new Promise((resolve, reject) => {
    // Timeout handling
    const maxTimeoutMs = maxTimeoutSeconds * 1000;
    const inactivityTimeoutMs = inactivityTimeoutSeconds * 1000;
    
    let maxTimeoutId: NodeJS.Timeout | null = null;
    let inactivityTimeoutId: NodeJS.Timeout | null = null;
    let startupCheckIntervalId: NodeJS.Timeout | null = null;
    let isResolved = false;

    // Helper to clear all timeouts
    const clearAllTimeouts = () => {
      if (maxTimeoutId) {
        clearTimeout(maxTimeoutId);
        maxTimeoutId = null;
      }
      if (inactivityTimeoutId) {
        clearTimeout(inactivityTimeoutId);
        inactivityTimeoutId = null;
      }
      if (startupCheckIntervalId) {
        clearInterval(startupCheckIntervalId);
        startupCheckIntervalId = null;
      }
    };

    // Helper to reset inactivity timeout
    const resetInactivityTimeout = () => {
      if (inactivityTimeoutId) {
        clearTimeout(inactivityTimeoutId);
      }
      
      inactivityTimeoutId = setTimeout(async () => {
        if (isResolved) return;
        isResolved = true;
        logger.warn(
          { inactivityTimeoutSeconds, accountsCollected: accountsMap.size },
          "Inactivity timeout reached during snapshot"
        );
        clearAllTimeouts();
        stream.destroy();

        // If we collected 0 accounts, run diagnostic to determine if stream is alive
        if (accountsMap.size === 0) {
          try {
            logger.info("No accounts collected. Running stream diagnostics...");
            const slotsReceived = await diagnosticSlotStream(client, 3);
            
            if (slotsReceived > 0) {
              logger.error(
                { slotsReceived },
                "DIAGNOSTIC: Yellowstone stream is ALIVE (slots > 0) but accounts subscription returned 0 results. Issue is likely with accounts filter shape, owner, or discriminator."
              );
            } else {
              logger.error(
                "DIAGNOSTIC: Yellowstone stream returned 0 slots. Issue is likely with endpoint URL, authentication token, or server not streaming."
              );
            }
          } catch (diagErr) {
            logger.error({ err: diagErr }, "Failed to run diagnostic slots stream");
          }
        }

        resolve(Array.from(accountsMap.values()));
      }, inactivityTimeoutMs);
    };

    // Set maximum timeout
    maxTimeoutId = setTimeout(async () => {
      if (isResolved) return;
      isResolved = true;
      logger.warn(
        { maxTimeoutSeconds, accountsCollected: accountsMap.size },
        "Maximum timeout reached during snapshot"
      );
      clearAllTimeouts();
      stream.destroy();
      
      // If we collected 0 accounts, run diagnostic to determine if stream is alive
      if (accountsMap.size === 0) {
        try {
          logger.info("No accounts collected. Running stream diagnostics...");
          const slotsReceived = await diagnosticSlotStream(client, 3);
          
          if (slotsReceived > 0) {
            logger.error(
              { slotsReceived },
              "DIAGNOSTIC: Yellowstone stream is ALIVE (slots > 0) but accounts subscription returned 0 results. Issue is likely with accounts filter shape, owner, or discriminator."
            );
          } else {
            logger.error(
              "DIAGNOSTIC: Yellowstone stream returned 0 slots. Issue is likely with endpoint URL, authentication token, or server not streaming."
            );
          }
        } catch (diagErr) {
          logger.error({ err: diagErr }, "Failed to run diagnostic slots stream");
        }
      }
      
      resolve(Array.from(accountsMap.values()));
    }, maxTimeoutMs);

    // Start inactivity timeout
    resetInactivityTimeout();
    
    // Start interval to check if startup is complete
    // End snapshot naturally when startup dump has finished
    startupCheckIntervalId = setInterval(() => {
      if (isResolved) return;
      
      // If we saw startup messages, have accounts, and haven't received startup in a while
      if (sawStartup && accountsMap.size > 0 && Date.now() - lastStartupAtMs > STARTUP_QUIET_MS) {
        isResolved = true;
        logger.info(
          { accountsCollected: accountsMap.size, quietMs: Date.now() - lastStartupAtMs },
          "Startup dump complete, ending snapshot naturally"
        );
        clearAllTimeouts();
        stream.destroy();
        resolve(Array.from(accountsMap.values()));
      }
    }, 500); // Check every 500ms

    stream.on("data", async (data: SubscribeUpdate) => {
      // Reset inactivity timeout on any data received
      resetInactivityTimeout();

      // Handle account updates
      if (data.account) {
        const accountInfo = data.account.account;
        if (!accountInfo) {
          return;
        }

        try {
          // Convert Uint8Array to Buffer and PublicKey
          const pubkeyBytes = Buffer.from(accountInfo.pubkey);
          const pubkey = new PublicKey(pubkeyBytes);
          const accountData = Buffer.from(accountInfo.data);
          const slot = BigInt(data.account.slot);
          
          // Track startup messages for natural snapshot ending
          if (data.account.isStartup) {
            sawStartup = true;
            lastStartupAtMs = Date.now();
          }

          // Collect accounts from BOTH startup and non-startup messages
          // Deduplicate by pubkey (keep latest by slot)
          const pubkeyStr = pubkey.toString();
          const existing = accountsMap.get(pubkeyStr);
          if (!existing || slot > existing[2]) {
            accountsMap.set(pubkeyStr, [pubkey, accountData, slot]);
          }

          // Track when startup accounts are complete for logging purposes
          if (!data.account.isStartup && !startupAccountsCompleted) {
            startupAccountsCompleted = true;
            logger.info(
              { startupCount: accountsMap.size },
              "Initial startup accounts received, continuing to collect non-startup updates"
            );
          }
        } catch (err) {
          logger.error({ err }, "Error processing account update");
        }
      }
    });

    stream.on("error", (err: Error) => {
      if (isResolved) return;
      isResolved = true;
      logger.error({ err }, "Yellowstone gRPC stream error");
      clearAllTimeouts();
      reject(err);
    });

    stream.on("end", () => {
      if (isResolved) return;
      isResolved = true;
      logger.info({ accountCount: accountsMap.size }, "Yellowstone gRPC stream ended");
      clearAllTimeouts();
      resolve(Array.from(accountsMap.values()));
    });

    stream.on("close", () => {
      if (isResolved) return;
      isResolved = true;
      logger.info({ accountCount: accountsMap.size }, "Yellowstone gRPC stream closed");
      clearAllTimeouts();
      resolve(Array.from(accountsMap.values()));
    });

    // Write the subscription request to the stream
    stream.write(request);

    logger.info("Subscription request sent, collecting initial accounts");
  });
}

/**
 * Diagnostic helper: Test if Yellowstone stream is alive by subscribing to slots
 * 
 * @param client - Connected Yellowstone gRPC client
 * @param testDurationSeconds - How long to wait for slot updates (default 3 seconds)
 * @returns Promise that resolves to the number of slots received
 */
async function diagnosticSlotStream(
  client: YellowstoneClientInstance,
  testDurationSeconds = 3
): Promise<number> {
  logger.info("Running diagnostic: checking if Yellowstone stream is alive via slots subscription");

  const request = {
    commitment: CommitmentLevel.CONFIRMED,
    accounts: {},
    slots: {
      slots: {},
    },
    accountsDataSlice: [],
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
  };

  const stream: Duplex = await client.subscribe();
  let slotCount = 0;

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      stream.destroy();
      resolve(slotCount);
    }, testDurationSeconds * 1000);

    stream.on("data", (data: SubscribeUpdate) => {
      if (data.slot) {
        slotCount++;
      }
    });

    stream.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      logger.error({ err }, "Diagnostic slots stream error");
      reject(err);
    });

    stream.on("end", () => {
      clearTimeout(timeoutId);
      resolve(slotCount);
    });

    stream.on("close", () => {
      clearTimeout(timeoutId);
      resolve(slotCount);
    });

    stream.write(request);
  });
}
