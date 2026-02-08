import { refreshObligation, refreshSubset } from '../forecast/forecastManager.js';
import { loadQueue } from '../scheduler/txScheduler.js';

export interface OrchestratorConfig {
  // thresholds
  minPricePctChange: number;       // e.g., 1% default
  minHealthDelta: number;          // e.g., 0.01
  minRefreshIntervalMs: number;    // per obligation throttle
}

export class EventRefreshOrchestrator {
  private cfg: OrchestratorConfig;
  private lastRefreshMsByKey = new Map<string, number>();
  // asset → obligation keys map (optional cache). Loaded from queue or mapping file.
  private assetToObligationKeys = new Map<string, string[]>();

  constructor(cfg?: Partial<OrchestratorConfig>) {
    this.cfg = {
      minPricePctChange: cfg?.minPricePctChange ?? 1.0,
      minHealthDelta: cfg?.minHealthDelta ?? 0.01,
      minRefreshIntervalMs: cfg?.minRefreshIntervalMs ?? 3000,
    };
    this.refreshAssetMapping();
  }

  refreshAssetMapping(): void {
    const queue = loadQueue();
    const tmpMap = new Map<string, Set<string>>();
    for (const p of queue) {
      const assets: string[] = Array.isArray((p as any).assets) ? (p as any).assets : [];
      for (const a of assets) {
        if (!tmpMap.has(a)) tmpMap.set(a, new Set<string>());
        tmpMap.get(a)!.add(p.key);
      }
    }
    this.assetToObligationKeys.clear();
    for (const [a, set] of tmpMap.entries()) {
      this.assetToObligationKeys.set(a, Array.from(set));
    }
  }

  private canRefresh(key: string): boolean {
    const last = this.lastRefreshMsByKey.get(key) ?? 0;
    const now = Date.now();
    if (now - last < this.cfg.minRefreshIntervalMs) return false;
    this.lastRefreshMsByKey.set(key, now);
    return true;
  }

  // Account updates typically include before/after health ratios, collateral/borrow deltas.
  handleAccountUpdate(ev: { pubkey: string; slot: number; before?: any; after?: any }): void {
    const key = ev.pubkey; // assuming pubkey equals plan.key (adjust if different)

    const beforeHealth = Number(ev.before?.health ?? ev.before?.healthRatio ?? NaN);
    const afterHealth = Number(ev.after?.health ?? ev.after?.healthRatio ?? NaN);
    const hasHealth = Number.isFinite(beforeHealth) && Number.isFinite(afterHealth);
    const delta = hasHealth ? Math.abs(afterHealth - beforeHealth) : 0;
    const isSignificant = hasHealth && delta >= this.cfg.minHealthDelta;

    // If not significant, only proceed if throttle allows; otherwise return early
    if (!isSignificant && !this.canRefresh(key)) return;
    // Always enforce per-obligation throttle
    if (!this.canRefresh(key)) return;

    const res = refreshObligation(key, ev.after, 'account-change');
    if (res.changed) {
      console.log(
        `[Orchestrator] Account-triggered refresh ${key} changed: ` +
        `EV ${Number(res.before?.ev ?? 0)} → ${Number(res.after?.ev ?? 0)}, ` +
        `TTL ${Number(res.before?.ttlMin ?? Infinity)} → ${Number(res.after?.ttlMin ?? Infinity)}, ` +
        `hazard ${Number(res.before?.hazard ?? 0)} → ${Number(res.after?.hazard ?? 0)}`
      );
    } else {
      console.log(`[Orchestrator] Account-triggered refresh ${key} no significant change (${res.reason ?? 'ok'})`);
    }
  }

  // Price update: map asset to obligation keys and refresh subset if pctChange threshold exceeded.
  handlePriceUpdate(ev: { assetMint: string; slot: number; price: number; prevPrice?: number; pctChange?: number }): void {
    const pct = Math.abs(ev.pctChange ?? 0);
    if (pct < this.cfg.minPricePctChange) return;

    const keys = this.assetToObligationKeys.get(ev.assetMint) ?? [];
    if (keys.length === 0) {
      // No mapping known; refreshAssetMapping might be stale. Attempt refresh mapping and try again.
      this.refreshAssetMapping();
    }
    const mappedKeys = this.assetToObligationKeys.get(ev.assetMint) ?? [];
    const refreshable = mappedKeys.filter(k => this.canRefresh(k));

    if (refreshable.length === 0) return;

    const results = refreshSubset(refreshable, undefined, `price-change ${pct.toFixed(2)}%`);
    for (const r of results) {
      if (r.changed) {
        console.log(`[Orchestrator] Price-triggered refresh ${r.key} changed:`);
        console.log(`  EV: ${Number(r.before?.ev ?? 0)} → ${Number(r.after?.ev ?? 0)}`);
        console.log(`  TTL: ${Number(r.before?.ttlMin ?? Infinity)} → ${Number(r.after?.ttlMin ?? Infinity)}`);
        console.log(`  Hazard: ${Number(r.before?.hazard ?? 0)} → ${Number(r.after?.hazard ?? 0)}`);
      } else {
        console.log(`[Orchestrator] Price-triggered refresh ${r.key} no significant change (${r.reason ?? 'ok'})`);
      }
    }
  }
}
