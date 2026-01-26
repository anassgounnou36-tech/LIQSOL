import YellowstoneGrpc from "@triton-one/yellowstone-grpc";
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

  // Create client with X-Token header for authentication
  // Type assertion is safe here as we're conforming to the interface
  const client = new (YellowstoneGrpc as unknown as new (
    endpoint: string,
    xToken: string | undefined,
    channelOptions: unknown
  ) => YellowstoneClientInstance)(url, xToken, undefined);

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
