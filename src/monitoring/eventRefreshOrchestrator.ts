import { buildMintObligationMapping, type MintToKeys, type KeyToMints } from './mintObligationMapping.js';
import { logger } from '../observability/logger.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';

export interface OrchestratorConfig {
  minPricePctChange: number; // not used in PR1 (no price decode), keep for future
  minHealthDelta: number; // account updates significance
  minRefreshIntervalMs: number; // per obligation throttle
  batchLimit: number; // bounded batch per event
}

export class EventRefreshOrchestrator {
  private cfg: OrchestratorConfig;
  private lastRefreshMsByKey = new Map<string, number>();
  private mintToKeys: MintToKeys;
  private keyToMints: KeyToMints;
  private onRefresh?: (keys: string[], reason: string) => void;

  constructor(cfg?: Partial<OrchestratorConfig>, onRefresh?: (keys: string[], reason: string) => void) {
    this.cfg = {
      minPricePctChange: cfg?.minPricePctChange ?? 1.0,
      minHealthDelta: cfg?.minHealthDelta ?? 0.01,
      minRefreshIntervalMs: cfg?.minRefreshIntervalMs ?? 3000,
      batchLimit: cfg?.batchLimit ?? Number(process.env.EVENT_REFRESH_BATCH_LIMIT ?? 50),
    };
    this.onRefresh = onRefresh;

    const mapping = buildMintObligationMapping();
    this.mintToKeys = mapping.mintToKeys;
    this.keyToMints = mapping.keyToMints;

    if (!this.mintToKeys || this.mintToKeys.size === 0) {
      logger.warn('Mint→obligation mapping is empty. Realtime mint-triggered refresh will be inactive until mapping is populated.');
    }

    logger.info(
      { uniqueMints: this.mintToKeys.size, totalObligations: this.keyToMints.size },
      'EventRefreshOrchestrator initialized with mint→obligation mapping'
    );
  }

  private canRefresh(key: string): boolean {
    const last = this.lastRefreshMsByKey.get(key) ?? 0;
    const now = Date.now();
    if (now - last < this.cfg.minRefreshIntervalMs) return false;
    this.lastRefreshMsByKey.set(key, now);
    return true;
  }

  // Account update: throttle-only gate with optional significance check (delta exceeded)
  handleAccountUpdate(ev: { pubkey: string; slot: number; before?: any; after?: any }): void {
    const key = ev.pubkey;
    const beforeHealth = Number(ev.before?.health ?? ev.before?.healthRatio ?? NaN);
    const afterHealth = Number(ev.after?.health ?? ev.after?.healthRatio ?? NaN);
    const delta = Number.isFinite(beforeHealth) && Number.isFinite(afterHealth) ? Math.abs(afterHealth - beforeHealth) : 0;
    const isSignificant = delta >= this.cfg.minHealthDelta;

    // Single-pass throttle check
    const ok = this.canRefresh(key);
    if (!ok) {
      logger.debug({ key, delta, isSignificant }, 'Account update throttled');
      return;
    }

    this.onRefresh?.([key], 'account-change');
  }

  getRefreshableKeysForMint(mint: string): string[] {
    if (this.mintToKeys.size === 0) return [];
    const keys = Array.from(this.mintToKeys.get(mint) ?? []);
    const refreshable: string[] = [];
    for (const k of keys) {
      if (refreshable.length >= this.cfg.batchLimit) break;
      if (this.canRefresh(k)) refreshable.push(k);
    }
    return refreshable;
  }

  handleMintUpdate(mint: string): void {
    const refreshable = this.getRefreshableKeysForMint(mint);
    if (refreshable.length === 0) {
      logger.debug({ mint }, 'No refreshable obligations for mint update');
      return;
    }
    this.onRefresh?.(refreshable, `mint-update ${mint}`);
  }

  /**
   * Refresh asset mapping (e.g., when queue is rebuilt).
   */
  refreshMapping(plans?: FlashloanPlan[]): void {
    if (!plans) {
      const mapping = buildMintObligationMapping();
      this.mintToKeys = mapping.mintToKeys;
      this.keyToMints = mapping.keyToMints;
      logger.info(
        { uniqueMints: this.mintToKeys.size, totalObligations: this.keyToMints.size },
        'Mint→obligation mapping refreshed'
      );
      return;
    }

    const mintToKeys: MintToKeys = new Map();
    const keyToMints: KeyToMints = new Map();
    for (const plan of plans) {
      const key = String(plan.key ?? '');
      if (!key) continue;
      const assets = Array.isArray(plan.assets) ? plan.assets : [];
      for (const mint of assets) {
        if (!mintToKeys.has(mint)) mintToKeys.set(mint, new Set());
        mintToKeys.get(mint)!.add(key);
        if (!keyToMints.has(key)) keyToMints.set(key, new Set());
        keyToMints.get(key)!.add(mint);
      }
    }

    this.mintToKeys = mintToKeys;
    this.keyToMints = keyToMints;
    logger.info(
      { uniqueMints: this.mintToKeys.size, totalObligations: this.keyToMints.size },
      'Mint→obligation mapping refreshed'
    );
  }
}
