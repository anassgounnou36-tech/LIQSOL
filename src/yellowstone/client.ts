import { logger } from "../observability/logger.js";
import { Duplex } from "stream";

/**
 * Type definition for Yellowstone gRPC Client instance
 */
export interface YellowstoneClientInstance {
  connect(): Promise<void>;
  subscribe(): Promise<Duplex>;
  getLatestBlockhash(commitment?: number): Promise<unknown>;
  ping(count: number): Promise<number>;
  getBlockHeight(commitment?: number): Promise<string>;
  getSlot(commitment?: number): Promise<string>;
  isBlockhashValid(blockhash: string, commitment?: number): Promise<unknown>;
  getVersion(): Promise<string>;
  subscribeReplayInfo(): Promise<unknown>;
}

/**
 * Initialize Yellowstone gRPC client using the provided URL and auth token.
 * 
 * @param url - The gRPC endpoint URL (e.g., https://solana-mainnet.g.alchemy.com/)
 * @param xToken - The authentication token (NEVER log this)
 * @returns Initialized Client instance
 */
export async function createYellowstoneClient(
  url: string,
  xToken: string
): Promise<YellowstoneClientInstance> {
  logger.info({ url }, "Initializing Yellowstone gRPC client");

  // Dynamically import the Yellowstone module to handle different export patterns
  const mod = await import("@triton-one/yellowstone-grpc");

  // Try different export patterns to find the correct constructor or factory
  const Ctor =
    (mod as any).YellowstoneGrpc ??
    (mod as any).Client ??
    (mod as any).default;

  let client: YellowstoneClientInstance;

  // Try constructor-based instantiation
  if (typeof Ctor === "function") {
    try {
      // Try different constructor signatures
      client = new Ctor(url, xToken, undefined) as YellowstoneClientInstance;
    } catch (err) {
      // Some versions might use different constructor args
      try {
        client = new Ctor(url, { "X-Token": xToken }) as YellowstoneClientInstance;
      } catch {
        throw new Error(
          `Failed to instantiate Yellowstone client: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } else {
    // Try factory function patterns
    const factory = (mod as any).createClient ?? (mod as any).connect;
    if (typeof factory === "function") {
      try {
        client = await factory(url, xToken);
      } catch (err) {
        // Try with options object
        try {
          client = await factory(url, { "X-Token": xToken });
        } catch {
          throw new Error(
            `Failed to create Yellowstone client via factory: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    } else {
      throw new Error(
        "Unsupported @triton-one/yellowstone-grpc export shape. Expected YellowstoneGrpc/Client/default constructor or createClient/connect factory."
      );
    }
  }

  // Connect to the gRPC server
  try {
    await client.connect();
    logger.info("Yellowstone gRPC client connected successfully");
  } catch (err) {
    logger.error({ err }, "Failed to connect Yellowstone gRPC client");
    throw err;
  }

  return client;
}
