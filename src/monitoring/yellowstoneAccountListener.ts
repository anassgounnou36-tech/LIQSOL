import { EventEmitter } from 'node:events';
import { CommitmentLevel } from '@triton-one/yellowstone-grpc';
import { PublicKey } from '@solana/web3.js';
import { createYellowstoneClient, type YellowstoneClientInstance } from '../yellowstone/client.js';
import { logger } from '../observability/logger.js';
import type { Duplex } from 'stream';

export interface AccountUpdateEvent {
  pubkey: string;
  slot: number;
  before?: any;
  after?: any;
}

export interface AccountListenerOptions {
  grpcUrl: string; // YELLOWSTONE_GRPC_URL
  authToken?: string; // YELLOWSTONE_X_TOKEN (optional)
  accountPubkeys: string[]; // explicit obligation/reserve pubkeys to subscribe to
  reconnectMs?: number; // base reconnect delay
  debounceMs?: number; // burst coalescing window (100–250ms)
}

export class YellowstoneAccountListener extends EventEmitter {
  private opts: AccountListenerOptions;
  private running = false;
  private reconnectCount = 0;
  private messagesReceived = 0;
  private lastMessageAt = 0;
  private dedupe = new Set<string>(); // key: `${pubkey}:${slot}`
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingEvents: AccountUpdateEvent[] = [];
  private client: YellowstoneClientInstance | null = null;
  private stream: Duplex | null = null;

  constructor(opts: AccountListenerOptions) {
    super();
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.running = true;
    this.emit('ready', { endpoint: this.opts.grpcUrl, tracked: this.opts.accountPubkeys.length });
    await this.subscribe();
  }

  async subscribe(): Promise<void> {
    if (!this.running) return;
    const { grpcUrl, authToken, accountPubkeys } = this.opts;

    try {
      // Create Yellowstone client
      this.client = await createYellowstoneClient(grpcUrl, authToken ?? '');

      // Create subscription request with explicit account pubkeys
      const request = {
        commitment: CommitmentLevel.CONFIRMED,
        accounts: {
          targets: {
            account: accountPubkeys,
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

      logger.debug({ accountCount: accountPubkeys.length }, 'Subscribing to explicit account pubkeys');

      this.stream = await this.client.subscribe();

      this.stream.on('data', (data: any) => {
        if (!this.running) return;

        // Handle account updates
        if (data.account) {
          const accountInfo = data.account.account;
          if (!accountInfo) return;

          try {
            const pubkeyBytes = Buffer.from(accountInfo.pubkey);
            const pubkey = new PublicKey(pubkeyBytes);
            const slot = Number(data.account.slot ?? 0);

            this.onMessage(pubkey.toString(), { slot });
          } catch (err) {
            logger.error({ err }, 'Error processing account update');
          }
        }

        // Handle ping updates (keep-alive)
        if (data.ping) {
          logger.debug('Received ping from Yellowstone gRPC');
        }
      });

      this.stream.on('error', (err: Error) => {
        logger.error({ err }, 'Yellowstone account stream error');
        this.onError(err);
      });

      this.stream.on('end', () => {
        logger.info('Yellowstone account stream ended');
        this.reconnect();
      });

      this.stream.on('close', () => {
        logger.info('Yellowstone account stream closed');
        this.reconnect();
      });

      // Write subscription request
      this.stream.write(request);

      this.emit('subscriptions-started', { count: accountPubkeys.length });
      logger.info({ count: accountPubkeys.length }, 'Account subscriptions started');
    } catch (e) {
      this.onError(e as Error);
    }
  }

  private onMessage(pubkey: string, msg: { slot: number; before?: any; after?: any }) {
    if (!this.running) return;
    const slot = Number(msg.slot ?? 0);
    const key = `${pubkey}:${slot}`;
    if (this.dedupe.has(key)) return;
    this.dedupe.add(key);
    this.messagesReceived++;
    this.lastMessageAt = Date.now();

    const ev: AccountUpdateEvent = { pubkey, slot, before: msg.before, after: msg.after };
    this.pendingEvents.push(ev);
    this.coalesce();
  }

  private coalesce() {
    const debounceMs = this.opts.debounceMs ?? 150;
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      const batch = this.pendingEvents.splice(0, this.pendingEvents.length);
      this.debounceTimer = null;
      for (const ev of batch) this.emit('account-update', ev);
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

  private reconnect() {
    if (!this.running) return;
    this.reconnectCount++;
    const base = this.opts.reconnectMs ?? 1000;
    const delay = Math.min(30000, base * Math.pow(2, this.reconnectCount));
    logger.info({ reconnectCount: this.reconnectCount, delayMs: delay }, 'Reconnecting account listener');
    setTimeout(() => this.subscribe(), delay);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.emit('stopped');
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pendingEvents = [];
    this.dedupe.clear();
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
    this.client = null;
  }

  // Test injection helper: simulate an account update arriving from stream
  simulateAccountUpdate(ev: AccountUpdateEvent) {
    if (!this.running) return;
    this.emit('account-update', ev);
  }
}
