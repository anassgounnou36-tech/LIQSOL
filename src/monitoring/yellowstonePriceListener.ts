import { EventEmitter } from 'node:events';

export interface PriceUpdateEvent {
  assetMint: string;  // base58 mint of asset
  slot: number;
  price: number;
  prevPrice?: number;
  pctChange?: number; // computed externally or by listener
}

export interface PriceListenerOptions {
  grpcEndpoint?: string;   // Yellowstone gRPC endpoint
  assetMints: string[];    // assets to monitor (e.g., USDC/SOL/etc.)
  reconnectMs?: number;
}

export class YellowstonePriceListener extends EventEmitter {
  private opts: PriceListenerOptions;
  private running = false;

  constructor(opts: PriceListenerOptions) {
    super();
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.running = true;
    this.emit('ready', { endpoint: this.opts.grpcEndpoint, tracked: this.opts.assetMints.length });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.emit('stopped');
  }

  // Test injection helper: simulate a price update arriving from stream
  simulatePriceUpdate(ev: PriceUpdateEvent) {
    if (!this.running) return;
    const pct =
      ev.prevPrice && ev.prevPrice > 0 ? ((ev.price - ev.prevPrice) / ev.prevPrice) * 100 : ev.pctChange ?? 0;
    this.emit('price-update', { ...ev, pctChange: pct });
  }
}
