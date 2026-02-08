import { EventEmitter } from 'node:events';
import { PublicKey } from '@solana/web3.js';
import { createYellowstoneClient, type YellowstoneClientInstance } from '../yellowstone/client.js';
import { logger } from '../observability/logger.js';
import type { Duplex } from 'stream';

export interface PriceUpdateEvent {
  oraclePubkey: string; // oracle account pubkey updated
  slot: number;
  mint?: string; // resolved externally from oracle→mint mapping
}

export interface PriceListenerOptions {
  grpcUrl: string; // YELLOWSTONE_GRPC_URL
  authToken?: string; // YELLOWSTONE_X_TOKEN (optional)
  oraclePubkeys: string[]; // explicit oracle pubkeys to subscribe to
  debounceMs?: number; // 100–250ms
  reconnectMs?: number;
}

// CommitmentLevel enum values from @triton-one/yellowstone-grpc
const CommitmentLevel = {
  PROCESSED: 0,
  CONFIRMED: 1,
  FINALIZED: 2,
} as const;

export class YellowstonePriceListener extends EventEmitter {
  private opts: PriceListenerOptions;
  private running = false;
  private reconnectCount = 0;
  private messagesReceived = 0;
  private lastMessageAt = 0;
  
  // Dedupe eviction: last slot per oracle pubkey (no memory leak)
  private lastSlotByOracle = new Map<string, number>();
  
  private pending: PriceUpdateEvent[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private client: YellowstoneClientInstance | null = null;
  private stream: Duplex | null = null;

  constructor(opts: PriceListenerOptions) {
    super();
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.running = true;
    this.emit('ready', { endpoint: this.opts.grpcUrl, tracked: this.opts.oraclePubkeys.length });
    await this.subscribe();
  }

  async subscribe(): Promise<void> {
    if (!this.running) return;
    const { grpcUrl, authToken, oraclePubkeys } = this.opts;

    try {
      // Clean up existing stream before creating new one
      this.cleanupStream();

      // Create Yellowstone client
      this.client = await createYellowstoneClient(grpcUrl, authToken ?? '');

      // Create subscription request with explicit oracle pubkeys
      const request = {
        commitment: CommitmentLevel.CONFIRMED,
        accounts: {
          oracles: {
            account: oraclePubkeys,
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

      logger.debug({ oracleCount: oraclePubkeys.length }, 'Subscribing to explicit oracle pubkeys');

      this.stream = await this.client.subscribe();

      this.stream.on('data', (data: any) => {
        if (!this.running) return;

        // Handle account updates (oracle price changes)
        if (data.account) {
          const accountInfo = data.account.account;
          if (!accountInfo) return;

          try {
            const pubkeyBytes = Buffer.from(accountInfo.pubkey);
            const pubkey = new PublicKey(pubkeyBytes);
            const slot = Number(data.account.slot ?? 0);

            this.onMessage(pubkey.toString(), { slot });
          } catch (err) {
            logger.error({ err }, 'Error processing oracle update');
          }
        }

        // Handle ping updates (keep-alive)
        if (data.ping) {
          logger.debug('Received ping from Yellowstone gRPC');
        }
      });

      this.stream.on('error', (err: Error) => {
        logger.error({ err }, 'Yellowstone price stream error');
        this.onError(err);
      });

      this.stream.on('end', () => {
        logger.info('Yellowstone price stream ended');
        this.reconnect();
      });

      this.stream.on('close', () => {
        logger.info('Yellowstone price stream closed');
        this.reconnect();
      });

      // Write subscription request
      this.stream.write(request);

      this.emit('subscriptions-started', { count: oraclePubkeys.length });
      logger.info({ count: oraclePubkeys.length }, 'Oracle subscriptions started');
    } catch (e) {
      this.onError(e as Error);
    }
  }

  private onMessage(oraclePubkey: string, msg: { slot: number }) {
    if (!this.running) return;
    const slot = Number(msg.slot ?? 0);
    
    // Dedupe eviction: ignore stale/duplicate slots per oracle
    const last = this.lastSlotByOracle.get(oraclePubkey) ?? 0;
    if (!(slot > last)) return;
    this.lastSlotByOracle.set(oraclePubkey, slot);

    // Reset reconnect backoff after first successful message
    if (this.messagesReceived === 0) {
      this.reconnectCount = 0;
    }

    this.messagesReceived++;
    this.lastMessageAt = Date.now();
    this.pending.push({ oraclePubkey, slot });
    this.coalesce();
  }

  private coalesce() {
    const debounceMs = this.opts.debounceMs ?? 150;
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      const batch = this.pending.splice(0, this.pending.length);
      this.debounceTimer = null;
      for (const ev of batch) this.emit('price-update', ev);
      this.emit('liveness', {
        lastMessageAt: this.lastMessageAt,
        messagesReceived: this.messagesReceived,
        reconnectCount: this.reconnectCount,
      });
    }, debounceMs);
  }

  private onError(err: Error) {
    this.emit('error', err);
    this.reconnect();
  }

  private cleanupStream() {
    // Best-effort destroy/close old stream to avoid leaks
    try {
      if (this.stream) {
        if (typeof this.stream.destroy === 'function') {
          this.stream.destroy();
        }
        this.stream = null;
      }
    } catch {
      // ignore cleanup errors
    }
  }

  private reconnect() {
    if (!this.running) return;
    const base = this.opts.reconnectMs ?? 1000;
    // Exponential backoff capped to 30s (increment happens before delay calculation)
    const delay = Math.min(30000, base * Math.pow(2, this.reconnectCount));
    this.reconnectCount++;
    logger.info({ reconnectCount: this.reconnectCount, delayMs: delay }, 'Reconnecting price listener');
    // Cleanup before resubscribe
    this.cleanupStream();
    setTimeout(() => this.subscribe(), delay);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.emit('stopped');
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pending = [];
    this.lastSlotByOracle.clear();
    this.cleanupStream();
    this.client = null;
  }

  // Test injection helper: simulate a price update arriving from stream
  simulatePriceUpdate(ev: PriceUpdateEvent & { price?: number; prevPrice?: number; pctChange?: number }) {
    if (!this.running) return;
    const pct =
      ev.prevPrice && ev.prevPrice > 0 && ev.price
        ? ((ev.price - ev.prevPrice) / ev.prevPrice) * 100
        : ev.pctChange ?? 0;
    this.emit('price-update', { oraclePubkey: ev.oraclePubkey, slot: ev.slot, mint: ev.mint, pctChange: pct });
  }
}
