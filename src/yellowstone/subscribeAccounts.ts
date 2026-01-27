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
 * Convert value to bigint for u64 gRPC fields
 */
function toU64(x: unknown): bigint {
  if (typeof x === "bigint") return x;
  if (typeof x === "number") return BigInt(x);
  if (typeof x === "string") return BigInt(x);
  return 0n;
}

/**
 * Normalize filters to ensure memcmp.offset is bigint for gRPC u64 compatibility
 */
function normalizeFilters(filters: any[]): any[] {
  return filters.map((f) => {
    if (f?.memcmp?.offset !== undefined) {
      return { ...f, memcmp: { ...f.memcmp, offset: toU64(f.memcmp.offset) } };
    }
    return f;
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
 * Subscribe to accounts owned by a program with optional filters
 * 
 * @param client - Connected Yellowstone gRPC client
 * @param programId - Program ID whose accounts to subscribe to
 * @param filters - Array of account filters (memcmp, datasize, etc.)
 * @param onAccountUpdate - Callback for each account update
 * @param commitment - Commitment level (defaults to confirmed)
 * @returns Promise that resolves when subscription completes or rejects on error
 */
export async function subscribeToAccounts(
  client: YellowstoneClientInstance,
  programId: PublicKey,
  filters: SubscribeRequestFilterAccounts["filters"],
  onAccountUpdate: AccountUpdateCallback,
  commitment: CommitmentLevel = CommitmentLevel.CONFIRMED
): Promise<void> {
  logger.info(
    { programId: programId.toString(), filtersCount: filters.length },
    "Starting account subscription via Yellowstone gRPC"
  );

  // Normalize filters to ensure memcmp.offset is bigint for u64 compatibility
  const normalizedFilters = normalizeFilters(filters as any[]);

  // Create subscription request
  const request = {
    accounts: {
      "obligation_accounts": {
        owner: [programId.toString()],
        account: [],
        filters: normalizedFilters,
        nonemptyTxnSignature: false,
      },
    },
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    commitment,
  };

  // Create the duplex stream for subscription
  const stream: Duplex = await client.subscribe();

  let accountCount = 0;
  let errorOccurred = false;

  return new Promise((resolve, reject) => {
    stream.on("data", async (data: SubscribeUpdate) => {
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
        logger.debug("Received ping from Yellowstone gRPC");
      }
    });

    stream.on("error", (err: Error) => {
      logger.error({ err }, "Yellowstone gRPC stream error");
      errorOccurred = true;
      reject(err);
    });

    stream.on("end", () => {
      logger.info({ accountCount }, "Yellowstone gRPC stream ended");
      if (!errorOccurred) {
        resolve();
      }
    });

    // Write the subscription request to the stream
    stream.write(request);

    logger.info("Subscription request sent, waiting for account updates");
  });
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

  const accounts: Array<[PublicKey, Buffer, bigint]> = [];
  let startupAccountsCompleted = false;

  // Normalize filters to ensure memcmp.offset is bigint for u64 compatibility
  const normalizedFilters = normalizeFilters(filters as any[]);

  // Create subscription request
  const request = {
    accounts: {
      "obligation_accounts": {
        owner: [programId.toString()],
        account: [],
        filters: normalizedFilters,
        nonemptyTxnSignature: false,
      },
    },
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    commitment,
  };

  // Create the duplex stream for subscription
  const stream: Duplex = await client.subscribe();

  return new Promise((resolve, reject) => {
    // Timeout handling
    const maxTimeoutMs = maxTimeoutSeconds * 1000;
    const inactivityTimeoutMs = inactivityTimeoutSeconds * 1000;
    
    let maxTimeoutId: NodeJS.Timeout | null = null;
    let inactivityTimeoutId: NodeJS.Timeout | null = null;
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
    };

    // Helper to reset inactivity timeout
    const resetInactivityTimeout = () => {
      if (inactivityTimeoutId) {
        clearTimeout(inactivityTimeoutId);
      }
      
      inactivityTimeoutId = setTimeout(() => {
        if (isResolved) return;
        isResolved = true;
        logger.warn(
          { inactivityTimeoutSeconds },
          "Inactivity timeout reached during snapshot"
        );
        clearAllTimeouts();
        stream.destroy();
        reject(new Error(`Snapshot inactivity timeout after ${inactivityTimeoutSeconds}s`));
      }, inactivityTimeoutMs);
    };

    // Set maximum timeout
    maxTimeoutId = setTimeout(() => {
      if (isResolved) return;
      isResolved = true;
      logger.warn(
        { maxTimeoutSeconds, accountsCollected: accounts.length },
        "Maximum timeout reached during snapshot"
      );
      clearAllTimeouts();
      stream.destroy();
      reject(new Error(`Snapshot maximum timeout after ${maxTimeoutSeconds}s`));
    }, maxTimeoutMs);

    // Start inactivity timeout
    resetInactivityTimeout();

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

          // Only collect startup accounts (initial snapshot)
          if (data.account.isStartup) {
            accounts.push([pubkey, accountData, slot]);
          } else {
            // Once we get a non-startup account, the initial snapshot is complete
            if (!startupAccountsCompleted) {
              startupAccountsCompleted = true;
              logger.info(
                { count: accounts.length },
                "Initial account snapshot complete, closing stream"
              );
              clearAllTimeouts();
              stream.destroy();
            }
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
      logger.info({ accountCount: accounts.length }, "Yellowstone gRPC stream ended");
      clearAllTimeouts();
      resolve(accounts);
    });

    stream.on("close", () => {
      if (isResolved) return;
      isResolved = true;
      logger.info({ accountCount: accounts.length }, "Yellowstone gRPC stream closed");
      clearAllTimeouts();
      resolve(accounts);
    });

    // Write the subscription request to the stream
    stream.write(request);

    logger.info("Subscription request sent, collecting initial accounts");
  });
}
