import { Buffer } from 'node:buffer';
import { Connection, PublicKey } from '@solana/web3.js';
import type { DecodedObligation } from '../kamino/types.js';
import { decodeObligation } from '../kamino/decoder.js';
import { computeHealthRatio } from '../math/health.js';
import { isLiquidatable } from '../math/liquidation.js';
import type { ReserveCache } from '../cache/reserveCache.js';
import { applyOracleAccountUpdate, type OracleCache } from '../cache/oracleCache.js';
import { refreshSubset } from '../forecast/forecastManager.js';
import { EventRefreshOrchestrator } from './eventRefreshOrchestrator.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';
import { logger } from '../observability/logger.js';

type CandidateLike = {
  key?: string;
  obligationPubkey?: string;
  ownerPubkey?: string;
  healthRatio?: number;
  healthRatioRaw?: number;
  borrowValueUsd?: number;
  collateralValueUsd?: number;
  liquidationEligible?: boolean;
  assets?: string[];
  repayReservePubkey?: string;
  collateralReservePubkey?: string;
  primaryBorrowMint?: string;
  primaryCollateralMint?: string;
};

export class RealtimeForecastUpdater {
  private connection: Connection;
  private marketPubkey: PublicKey;
  private programId: PublicKey;
  private reserveCache: ReserveCache;
  private oracleCache: OracleCache;
  private decodedByKey = new Map<string, DecodedObligation>();
  private candidatesByKey = new Map<string, CandidateLike>();
  private orchestrator: EventRefreshOrchestrator;
  private pendingKeys = new Set<string>();
  private pendingReason: string | undefined;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(opts: {
    connection: Connection;
    marketPubkey: PublicKey;
    programId: PublicKey;
    reserveCache: ReserveCache;
    oracleCache: OracleCache;
  }) {
    this.connection = opts.connection;
    this.marketPubkey = opts.marketPubkey;
    this.programId = opts.programId;
    this.reserveCache = opts.reserveCache;
    this.oracleCache = opts.oracleCache;
    this.orchestrator = new EventRefreshOrchestrator({}, (keys, reason) => {
      this.enqueueRefresh(keys, reason);
    });
  }

  private enqueueRefresh(keys: string[], reason: string): void {
    for (const key of keys) this.pendingKeys.add(key);
    this.pendingReason = reason;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = Array.from(this.pendingKeys);
      const batchReason = this.pendingReason ?? reason;
      this.pendingKeys.clear();
      this.pendingReason = undefined;
      if (batch.length === 0) return;
      refreshSubset(batch, this.candidatesByKey, batchReason);
    }, 75);
  }

  private deriveAssets(decoded: DecodedObligation): string[] | undefined {
    const assets = new Set<string>();
    for (const d of decoded.deposits) {
      const reserve = this.reserveCache.byReserve.get(d.reserve);
      if (reserve?.liquidityMint) assets.add(reserve.liquidityMint);
    }
    for (const b of decoded.borrows) {
      const reserve = this.reserveCache.byReserve.get(b.reserve);
      if (reserve?.liquidityMint) assets.add(reserve.liquidityMint);
    }
    return assets.size > 0 ? Array.from(assets) : undefined;
  }

  private recomputeCandidateLike(key: string): void {
    const decoded = this.decodedByKey.get(key);
    if (!decoded) return;

    const existing = this.candidatesByKey.get(key) ?? { key, obligationPubkey: key };
    const health = computeHealthRatio({
      deposits: decoded.deposits,
      borrows: decoded.borrows,
      reserves: this.reserveCache.byMint,
      prices: this.oracleCache,
      options: { exposeRawHr: true },
    });

    if (!health.scored) {
      this.candidatesByKey.set(key, {
        ...existing,
        key,
        obligationPubkey: key,
        ownerPubkey: decoded.ownerPubkey,
        assets: this.deriveAssets(decoded) ?? existing.assets,
      });
      return;
    }

    this.candidatesByKey.set(key, {
      ...existing,
      key,
      obligationPubkey: key,
      ownerPubkey: decoded.ownerPubkey,
      healthRatio: health.healthRatio,
      healthRatioRaw: health.healthRatioRaw ?? health.healthRatio,
      borrowValueUsd: health.borrowValue,
      collateralValueUsd: health.collateralValue,
      liquidationEligible: isLiquidatable(health.healthRatio),
      assets: this.deriveAssets(decoded) ?? existing.assets,
    });
  }

  async bootstrapQueueObligations(keys: string[]): Promise<void> {
    const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
    if (uniqueKeys.length === 0) return;

    const BATCH_SIZE = 100;
    for (let i = 0; i < uniqueKeys.length; i += BATCH_SIZE) {
      const batch = uniqueKeys.slice(i, i + BATCH_SIZE);
      const pubkeys = batch.map((k) => new PublicKey(k));
      const accounts = await this.connection.getMultipleAccountsInfo(pubkeys, 'confirmed');
      for (let j = 0; j < batch.length; j++) {
        const account = accounts[j];
        if (!account?.data) continue;
        try {
          const decoded = decodeObligation(account.data, pubkeys[j]);
          if (decoded.marketPubkey !== this.marketPubkey.toString()) continue;
          this.decodedByKey.set(batch[j], decoded);
          this.recomputeCandidateLike(batch[j]);
        } catch (err) {
          logger.debug({ key: batch[j], err }, 'Failed to bootstrap obligation decode');
        }
      }
    }
  }

  handleObligationAccountUpdate(ev: {
    pubkey: string;
    slot: number;
    owner?: string;
    dataBase64?: string;
  }): void {
    if (ev.owner && ev.owner !== this.programId.toString()) return;
    if (!ev.dataBase64) {
      logger.warn({ key: ev.pubkey }, 'Obligation update missing account data bytes');
      return;
    }
    try {
      const data = Buffer.from(ev.dataBase64, 'base64');
      const decoded = decodeObligation(data, new PublicKey(ev.pubkey));
      if (decoded.marketPubkey !== this.marketPubkey.toString()) return;
      this.decodedByKey.set(ev.pubkey, decoded);
      this.recomputeCandidateLike(ev.pubkey);
      this.orchestrator.handleAccountUpdate({ pubkey: ev.pubkey, slot: ev.slot });
    } catch (err) {
      logger.debug({ key: ev.pubkey, err }, 'Failed to decode obligation account update');
    }
  }

  handleOracleAccountUpdate(ev: {
    oraclePubkey: string;
    slot: number;
    owner?: string;
    dataBase64?: string;
  }): void {
    if (!ev.owner || !ev.dataBase64) {
      logger.warn({ oraclePubkey: ev.oraclePubkey }, 'Oracle update missing owner or account data bytes');
      return;
    }

    let owner: PublicKey;
    try {
      owner = new PublicKey(ev.owner);
    } catch {
      return;
    }
    const data = Buffer.from(ev.dataBase64, 'base64');
    const { updatedMints } = applyOracleAccountUpdate({
      oraclePubkey: ev.oraclePubkey,
      owner,
      data,
      reserveCache: this.reserveCache,
      oracleCache: this.oracleCache,
    });

    if (updatedMints.length === 0) return;

    const keysToRefresh = new Set<string>();
    for (const mint of updatedMints) {
      const refreshable = this.orchestrator.getRefreshableKeysForMint(mint);
      for (const key of refreshable) {
        if (!this.decodedByKey.has(key)) continue;
        this.recomputeCandidateLike(key);
        keysToRefresh.add(key);
      }
    }

    if (keysToRefresh.size > 0) {
      this.enqueueRefresh(Array.from(keysToRefresh), 'rt-oracle-update');
    }
  }

  refreshMappingFromQueue(plans: FlashloanPlan[]): void {
    const nextKeys = new Set<string>();
    for (const plan of plans) {
      const key = String(plan.key ?? '');
      if (!key) continue;
      nextKeys.add(key);
      const existing = this.candidatesByKey.get(key);
      this.candidatesByKey.set(key, {
        ...existing,
        key,
        obligationPubkey: key,
        ownerPubkey: plan.ownerPubkey ?? existing?.ownerPubkey,
        borrowValueUsd: plan.amountUsd ?? existing?.borrowValueUsd,
        liquidationEligible: plan.liquidationEligible ?? existing?.liquidationEligible,
        repayReservePubkey: plan.repayReservePubkey ?? existing?.repayReservePubkey,
        collateralReservePubkey: plan.collateralReservePubkey ?? existing?.collateralReservePubkey,
        primaryBorrowMint: plan.repayMint ?? existing?.primaryBorrowMint,
        primaryCollateralMint: plan.collateralMint ?? existing?.primaryCollateralMint,
        assets: plan.assets ?? existing?.assets,
      });
    }

    for (const key of Array.from(this.candidatesByKey.keys())) {
      if (!nextKeys.has(key)) this.candidatesByKey.delete(key);
    }
    for (const key of Array.from(this.decodedByKey.keys())) {
      if (!nextKeys.has(key)) this.decodedByKey.delete(key);
    }

    this.orchestrator.refreshMapping(plans);
  }
}
