import { refreshSubset } from '../forecast/forecastManager.js';
import { buildMintObligationMapping, type MintToKeys, type KeyToMints } from './mintObligationMapping.js';
import { logger } from '../observability/logger.js';

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

  constructor(cfg?: Partial<OrchestratorConfig>) {
    this.cfg = {
      minPricePctChange: cfg?.minPricePctChange ?? 1.0,
      minHealthDelta: cfg?.minHealthDelta ?? 0.01,
      minRefreshIntervalMs: cfg?.minRefreshIntervalMs ?? 3000,
      batchLimit: cfg?.batchLimit ?? Number(process.env.EVENT_REFRESH_BATCH_LIMIT ?? 50),
    };

    const mapping = buildMintObligationMapping();
    this.mintToKeys = mapping.mintToKeys;
    this.keyToMints = mapping.keyToMints;

    // Fail-fast to avoid silently doing nothing
    if (!this.mintToKeys || this.mintToKeys.size === 0) {
      throw new Error('Mint→obligation mapping is empty. Ensure data/tx_queue.json or data/candidates.json exists.');
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

    const results = refreshSubset([key], undefined, 'account-change');
    for (const r of results) {
      if (r.changed) {
        logger.info(
          {
            key: r.key,
            evBefore: Number(r.before?.ev ?? 0),
            evAfter: Number(r.after?.ev ?? 0),
            ttlBefore: Number(r.before?.ttlMin ?? Infinity),
            ttlAfter: Number(r.after?.ttlMin ?? Infinity),
            hazardBefore: Number(r.before?.hazard ?? 0),
            hazardAfter: Number(r.after?.hazard ?? 0),
          },
          'Account refresh changed'
        );
      } else {
        logger.debug({ key: r.key, reason: r.reason }, 'Account refresh no significant change');
      }
    }
  }

  // Price update: refresh only obligations mapped to the updated mint; bounded batch; single-pass throttle
  handlePriceUpdate(ev: { oraclePubkey: string; slot: number; mint?: string }): void {
    const mint = ev.mint; // PR1: this must be resolved externally before calling
    if (!mint) {
      logger.debug({ oraclePubkey: ev.oraclePubkey }, 'Price update without mint mapping, skipping');
      return;
    }

    const keys = Array.from(this.mintToKeys.get(mint) ?? []);
    if (keys.length === 0) {
      logger.debug({ mint }, 'No obligations mapped to mint, skipping');
      return;
    }

    const refreshable: string[] = [];
    for (const k of keys) {
      if (refreshable.length >= this.cfg.batchLimit) break;
      if (this.canRefresh(k)) refreshable.push(k);
    }

    if (refreshable.length === 0) {
      logger.debug({ mint, totalKeys: keys.length }, 'All obligations throttled for mint update');
      return;
    }

    logger.debug({ mint, refreshable: refreshable.length, total: keys.length }, 'Refreshing obligations for mint update');

    const results = refreshSubset(refreshable, undefined, `mint-update ${mint}`);
    for (const r of results) {
      if (r.changed) {
        logger.info(
          {
            key: r.key,
            evBefore: Number(r.before?.ev ?? 0),
            evAfter: Number(r.after?.ev ?? 0),
            ttlBefore: Number(r.before?.ttlMin ?? Infinity),
            ttlAfter: Number(r.after?.ttlMin ?? Infinity),
            hazardBefore: Number(r.before?.hazard ?? 0),
            hazardAfter: Number(r.after?.hazard ?? 0),
          },
          'Mint refresh changed'
        );
      } else {
        logger.debug({ key: r.key, reason: r.reason }, 'Mint refresh no significant change');
      }
    }
  }

  /**
   * Refresh asset mapping (e.g., when queue is rebuilt).
   */
  refreshMapping(): void {
    const mapping = buildMintObligationMapping();
    this.mintToKeys = mapping.mintToKeys;
    this.keyToMints = mapping.keyToMints;
    logger.info(
      { uniqueMints: this.mintToKeys.size, totalObligations: this.keyToMints.size },
      'Mint→obligation mapping refreshed'
    );
  }
}
