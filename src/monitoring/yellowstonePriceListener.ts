import { EventEmitter } from 'node:events';
import { PublicKey } from '@solana/web3.js';
import { createYellowstoneClient, type YellowstoneClientInstance } from '../yellowstone/client.js';
import { logger } from '../observability/logger.js';
import type { Duplex } from 'stream';

export interface PriceUpdateEvent {
  oraclePubkey: string;
  slot: number;
  mint?: string;
  owner?: string;
  dataBase64?: string;
  writeVersion?: number;
}

export interface PriceListenerOptions {
  grpcUrl: string;
  authToken?: string;
  oraclePubkeys: string[];
  debounceMs?: number;
  reconnectMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  resubscribeSettleMs?: number;
}

const CommitmentLevel = {
  PROCESSED: 0,
  CONFIRMED: 1,
  FINALIZED: 2,
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class YellowstonePriceListener extends EventEmitter {
  private opts: PriceListenerOptions;
  private running = false;
  private reconnectCount = 0;
  private messagesReceived = 0;
  private lastMessageAt = 0;
  private lastSeenByOracle = new Map<string, { slot: number; writeVersion: number }>();
  private pending: PriceUpdateEvent[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private client: YellowstoneClientInstance | null = null;
  private stream: Duplex | null = null;
  private sessionHasData = false;
  private sessionId = 0;
  private plannedRestart = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(opts: PriceListenerOptions) {
    super();
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.running = true;
    this.emit('ready', { endpoint: this.opts.grpcUrl, tracked: this.opts.oraclePubkeys.length });
    await this.subscribe('start');
  }

  private async subscribe(reason: string): Promise<void> {
    if (!this.running) return;
    const { grpcUrl, authToken, oraclePubkeys } = this.opts;
    this.cleanupReconnectTimer();
    this.cleanupStream();
    this.sessionId += 1;
    this.sessionHasData = false;

    try {
      this.client = await createYellowstoneClient(grpcUrl, authToken ?? '');
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

      this.stream = await this.client.subscribe();
      this.stream.on('data', (data: any) => {
        if (!this.running) return;
        if (data.account) {
          const accountInfo = data.account.account;
          if (!accountInfo) return;
          try {
            const accountPubkey = new PublicKey(Buffer.from(accountInfo.pubkey)).toString();
            const slot = Number(data.account.slot ?? 0);
            const ownerBytes = accountInfo.owner ? Buffer.from(accountInfo.owner) : undefined;
            const owner = ownerBytes && ownerBytes.length > 0 ? new PublicKey(ownerBytes).toString() : undefined;
            const dataBytes = accountInfo.data ? Buffer.from(accountInfo.data) : undefined;
            const dataBase64 = dataBytes && dataBytes.length > 0 ? dataBytes.toString('base64') : undefined;
            const writeVersionRaw = Number(data.account.writeVersion ?? accountInfo.writeVersion);
            const writeVersion = Number.isFinite(writeVersionRaw) ? writeVersionRaw : undefined;
            this.onMessage(accountPubkey, { slot, owner, dataBase64, writeVersion });
          } catch (err) {
            logger.error({ err }, 'Error processing oracle update');
          }
        }
      });

      this.stream.on('error', (err: Error) => {
        this.handleStreamFailure('error', err);
      });
      this.stream.on('end', () => {
        this.handleStreamFailure('end');
      });
      this.stream.on('close', () => {
        this.handleStreamFailure('close');
      });

      this.stream.write(request);
      this.emit('subscriptions-started', { count: oraclePubkeys.length });
      logger.info(
        { listener: 'price', reason, targetCount: oraclePubkeys.length, sessionId: this.sessionId },
        'Yellowstone price session started',
      );
    } catch (err) {
      this.handleStreamFailure('error', err as Error);
    }
  }

  private onMessage(
    oraclePubkey: string,
    msg: { slot: number; owner?: string; dataBase64?: string; writeVersion?: number },
  ): void {
    if (!this.running) return;
    const slot = Number(msg.slot ?? 0);
    const writeVersion = Number(msg.writeVersion ?? -1);
    const last = this.lastSeenByOracle.get(oraclePubkey);
    const isNewer = !last || slot > last.slot || (slot === last.slot && writeVersion > last.writeVersion);
    if (!isNewer) return;
    this.lastSeenByOracle.set(oraclePubkey, { slot, writeVersion });

    if (!this.sessionHasData) {
      this.sessionHasData = true;
      this.reconnectCount = 0;
    }
    this.messagesReceived++;
    this.lastMessageAt = Date.now();
    this.pending.push({
      oraclePubkey,
      slot,
      owner: msg.owner,
      dataBase64: msg.dataBase64,
      writeVersion: msg.writeVersion,
    });
    this.coalesce();
  }

  private coalesce(): void {
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

  private handleStreamFailure(kind: 'error' | 'end' | 'close', err?: Error): void {
    if (!this.running) return;
    if (this.plannedRestart) return;
    if (kind === 'error' && err) {
      this.emit('error', err);
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.cleanupReconnectTimer();
    const base = this.opts.reconnectBaseMs ?? this.opts.reconnectMs ?? 1_000;
    const max = this.opts.reconnectMaxMs ?? 30_000;
    const delayMs = Math.min(max, base * Math.pow(2, this.reconnectCount));
    this.reconnectCount++;
    logger.info(
      { listener: 'price', reconnectCount: this.reconnectCount, delayMs, sessionId: this.sessionId },
      'Yellowstone listener reconnect scheduled',
    );
    this.cleanupStream();
    this.reconnectTimer = setTimeout(() => {
      void this.subscribe('reconnect');
    }, delayMs);
  }

  private cleanupReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private cleanupStream(): void {
    const stream = this.stream;
    this.stream = null;
    try {
      if (stream) {
        stream.removeAllListeners();
        if (typeof stream.destroy === 'function') {
          stream.destroy();
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }

  updateTargets(oraclePubkeys: string[]): void {
    this.opts.oraclePubkeys = oraclePubkeys;
    if (!this.running) return;
    void this.restartPlanned();
  }

  private async restartPlanned(): Promise<void> {
    this.plannedRestart = true;
    this.cleanupReconnectTimer();
    this.cleanupStream();
    const targetCount = this.opts.oraclePubkeys.length;
    const nextSessionId = this.sessionId + 1;
    logger.info(
      { listener: 'price', targetCount, sessionId: nextSessionId, reason: 'planned-restart' },
      'Yellowstone listener planned restart',
    );
    try {
      await sleep(this.opts.resubscribeSettleMs ?? 250);
      if (!this.running) return;
      await this.subscribe('planned-restart');
    } finally {
      this.plannedRestart = false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.emit('stopped');
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pending = [];
    this.lastSeenByOracle.clear();
    this.cleanupReconnectTimer();
    this.cleanupStream();
    this.client = null;
  }

  simulatePriceUpdate(ev: PriceUpdateEvent & { price?: number; prevPrice?: number; pctChange?: number }): void {
    if (!this.running) return;
    const pct =
      ev.prevPrice && ev.prevPrice > 0 && ev.price
        ? ((ev.price - ev.prevPrice) / ev.prevPrice) * 100
        : ev.pctChange ?? 0;
    this.emit('price-update', {
      oraclePubkey: ev.oraclePubkey,
      slot: ev.slot,
      mint: ev.mint,
      owner: ev.owner,
      dataBase64: ev.dataBase64,
      writeVersion: ev.writeVersion,
      pctChange: pct,
    });
  }
}
