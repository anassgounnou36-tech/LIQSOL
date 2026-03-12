import { loadShadowWatchTargets, type ShadowWatchTarget } from '../monitoring/shadowWatchlist.js';

export interface WatchStateSnapshot {
  queueTargets: ShadowWatchTarget[];
  shadowOnlyTargets: ShadowWatchTarget[];
  allWatchTargets: ShadowWatchTarget[];
  loadedAtMs: number;
  fingerprints: Set<string>;
}

function toFingerprint(target: ShadowWatchTarget): string {
  return JSON.stringify({
    key: target.key,
    obligationPubkey: target.obligationPubkey,
    ownerPubkey: target.ownerPubkey,
    assets: target.assets ?? [],
    repayReservePubkey: target.repayReservePubkey,
    collateralReservePubkey: target.collateralReservePubkey,
    primaryBorrowMint: target.primaryBorrowMint,
    primaryCollateralMint: target.primaryCollateralMint,
    rankBucket: target.rankBucket,
    ttlMinutes: target.forecast?.ttlMinutes ?? null,
  });
}

function emptySnapshot(): WatchStateSnapshot {
  return {
    queueTargets: [],
    shadowOnlyTargets: [],
    allWatchTargets: [],
    loadedAtMs: Date.now(),
    fingerprints: new Set<string>(),
  };
}

export class WatchStateStore {
  private current = emptySnapshot();

  loadFromFiles(): WatchStateSnapshot {
    const loaded = loadShadowWatchTargets();
    const allWatchTargets = loaded.allTargets.map(target => ({ ...target }));
    return {
      queueTargets: loaded.queueTargets.map(target => ({ ...target })),
      shadowOnlyTargets: loaded.shadowOnlyTargets.map(target => ({ ...target })),
      allWatchTargets,
      loadedAtMs: Date.now(),
      fingerprints: new Set(allWatchTargets.map(toFingerprint)),
    };
  }

  replace(snapshot: WatchStateSnapshot): void {
    this.current = snapshot;
  }

  getCurrent(): WatchStateSnapshot {
    return this.current;
  }
}
