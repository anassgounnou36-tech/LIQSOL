import { Connection } from "@solana/web3.js";
import { logger } from "../observability/logger.js";

export class ConnectionManager {
  private readonly _primary: Connection;
  private readonly _secondary?: Connection;
  private lastPrimaryMs = Infinity;
  private lastSecondaryMs = Infinity;

  constructor(
    primaryUrl: string, 
    secondaryUrl?: string,
    wsPrimaryUrl?: string,
    wsSecondaryUrl?: string
  ) {
    this._primary = new Connection(primaryUrl, {
      commitment: "confirmed",
      wsEndpoint: wsPrimaryUrl,
    });
    if (secondaryUrl) {
      this._secondary = new Connection(secondaryUrl, {
        commitment: "confirmed",
        wsEndpoint: wsSecondaryUrl,
      });
    }
  }

  get primary(): Connection {
    return this._primary;
  }

  get secondary(): Connection | undefined {
    return this._secondary;
  }

  async refreshLatencies(): Promise<void> {
    // Ping primary
    try {
      const t0 = Date.now();
      await this._primary.getSlot("processed");
      this.lastPrimaryMs = Date.now() - t0;
    } catch (err) {
      logger.warn({ err, rpc: "primary" }, "primary connection failed");
      this.lastPrimaryMs = Infinity;
    }

    // Ping secondary if exists
    if (this._secondary) {
      try {
        const t0 = Date.now();
        await this._secondary.getSlot("processed");
        this.lastSecondaryMs = Date.now() - t0;
      } catch (err) {
        logger.warn({ err, rpc: "secondary" }, "secondary connection failed");
        this.lastSecondaryMs = Infinity;
      }
    }
  }

  getConnection(): Connection {
    if (!this._secondary) {
      return this._primary;
    }
    return this.lastPrimaryMs <= this.lastSecondaryMs ? this._primary : this._secondary;
  }
}
