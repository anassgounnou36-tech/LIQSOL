import { Connection } from "@solana/web3.js";
import { logger } from "../observability/logger.js";

export class BlockhashManager {
  private conn: Connection;
  private safetyBlocks: number;
  private cachedBlockhash?: string;
  private cachedLastValidBlockHeight?: number;

  constructor(connection: Connection, safetyBlocks = 30) {
    this.conn = connection;
    this.safetyBlocks = safetyBlocks;
  }

  async getFresh(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const currentSlot = await this.conn.getSlot("processed");

    // Check if we need to refresh
    if (
      this.cachedBlockhash &&
      this.cachedLastValidBlockHeight !== undefined &&
      currentSlot < this.cachedLastValidBlockHeight - this.safetyBlocks
    ) {
      logger.debug(
        { slot: currentSlot, cached_expiry: this.cachedLastValidBlockHeight },
        "using cached blockhash"
      );
      return {
        blockhash: this.cachedBlockhash,
        lastValidBlockHeight: this.cachedLastValidBlockHeight
      };
    }

    // Refresh blockhash
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("processed");
    this.cachedBlockhash = blockhash;
    this.cachedLastValidBlockHeight = lastValidBlockHeight;

    logger.debug(
      { slot: currentSlot, lastValidBlockHeight },
      "refreshed blockhash"
    );

    return { blockhash, lastValidBlockHeight };
  }
}
