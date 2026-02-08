import { EventEmitter } from 'node:events';

export interface AccountUpdateEvent {
  pubkey: string;
  slot: number;
  before?: any;
  after?: any;
}

export interface AccountListenerOptions {
  grpcEndpoint?: string; // Yellowstone gRPC endpoint
  obligationPubkeys: string[]; // pubkeys to monitor
  reservePubkeys?: string[];   // optional reserves to monitor
  reconnectMs?: number;        // auto-reconnect delay
}

export class YellowstoneAccountListener extends EventEmitter {
  private opts: AccountListenerOptions;
  private running = false;

  constructor(opts: AccountListenerOptions) {
    super();
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.running = true;
    // TODO: replace with real Yellowstone gRPC client subscription.
    // For now, emit a 'ready' event and wait for external test injects.
    this.emit('ready', { endpoint: this.opts.grpcEndpoint, monitored: this.opts.obligationPubkeys.length });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.emit('stopped');
  }

  // Test injection helper: simulate an account update arriving from stream
  simulateAccountUpdate(ev: AccountUpdateEvent) {
    if (!this.running) return;
    this.emit('account-update', ev);
  }
}
