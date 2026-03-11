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
import { buildPlanAwareEvContext, type PlanAwareEvContext } from '../predict/evContext.js';
import { buildPairAwareTtlContext, type PairAwareTtlContext } from '../predict/ttlContext.js';
import { loadQueue } from '../scheduler/txScheduler.js';
import type { ShadowWatchTarget } from './shadowWatchlist.js';
import { buildShadowPromotionSummarySignature, promoteWatchedCandidatesToQueue } from './shadowWatchPromotion.js';

export type CandidateLike = {
  key?: string;
  obligationPubkey?: string;
  ownerPubkey?: string;
  healthRatio?: number;
  healthRatioRaw?: number;
  borrowValueUsd?: number;
  collateralValueUsd?: number;
  liquidationEligible?: boolean;
  healthSource?: string;
  healthSourceUsed?: string;
  healthSourceVerified?: string;
  assets?: string[];
  repayReservePubkey?: string;
  collateralReservePubkey?: string;
  primaryBorrowMint?: string;
  primaryCollateralMint?: string;
  ttlContext?: PairAwareTtlContext;
  rankBucket?: 'liquidatable' | 'near-ready' | 'medium-horizon' | 'far-horizon' | 'legacy-or-unknown';
  predictedLiquidationAtMs?: number | string | null;
  ttlComputedAtMs?: number | string | null;
  createdAtMs?: number | string | null;
  forecast?: {
    ttlMinutes?: number | null;
    timeToLiquidation?: string;
    model?: string;
    confidence?: 'high' | 'medium' | 'low';
    driverMint?: string;
    driverSide?: 'deposit' | 'borrow';
    requiredMovePct?: number;
  };
  ev?: number;
  hazard?: number;
  evContext?: PlanAwareEvContext;
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
  private lastPromotionSummarySignature = '';
  private lastPromotionSummaryLoggedAtMs = 0;

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
      const queuedKeys = new Set(loadQueue().map((plan) => String(plan.key)));
      const queuedBatch = batch.filter((key) => queuedKeys.has(key));
      const watchOnlyBatch = batch.filter((key) => !queuedKeys.has(key));
      if (queuedBatch.length > 0) {
        refreshSubset(queuedBatch, this.candidatesByKey, batchReason);
      }
        if (watchOnlyBatch.length > 0) {
          void promoteWatchedCandidatesToQueue({
            keys: watchOnlyBatch,
            candidatesByKey: this.candidatesByKey,
          }).then((result) => {
            const signature = buildShadowPromotionSummarySignature(result);
            const now = Date.now();
            const intervalMs = Number(process.env.LIVE_PROMOTION_SUMMARY_LOG_INTERVAL_MS ?? 10_000);
            const signatureChanged = signature !== this.lastPromotionSummarySignature;
            const shouldLog = signatureChanged || now - this.lastPromotionSummaryLoggedAtMs >= intervalMs;
            if (!shouldLog) {
              return;
            }
            this.lastPromotionSummarySignature = signature;
            this.lastPromotionSummaryLoggedAtMs = now;
            logger.info(
              {
                watchOnlyKeys: watchOnlyBatch.length,
              considered: result.considered,
              ranked: result.ranked,
              queueEligible: result.queueEligible,
              verifiedByKlend: result.verifiedByKlend,
              admittedByKlend: result.admittedByKlend,
              skippedByHealthyCooldown: result.skippedByHealthyCooldown,
              enqueued: result.enqueued,
              rejectedReasons: result.rejectedReasons,
            },
            'Shadow watch promotion flush result',
          );
        }).catch((err) => {
          logger.warn({ err, watchOnlyBatch: watchOnlyBatch.length }, 'Shadow watch promotion failed');
        });
      }
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
      options: { includeBreakdown: true, exposeRawHr: true },
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

    let evContext: PlanAwareEvContext | undefined = existing.evContext;
    if (
      existing.repayReservePubkey &&
      existing.collateralReservePubkey &&
      existing.primaryBorrowMint &&
      existing.primaryCollateralMint
    ) {
      evContext = buildPlanAwareEvContext({
        decoded,
        reserveCache: this.reserveCache,
        oracleCache: this.oracleCache,
        selectedBorrowReservePubkey: existing.repayReservePubkey,
        selectedCollateralReservePubkey: existing.collateralReservePubkey,
        selectedBorrowMint: existing.primaryBorrowMint,
        selectedCollateralMint: existing.primaryCollateralMint,
      });
    }
    const ttlContext = buildPairAwareTtlContext({
      decoded,
      reserveCache: this.reserveCache,
      oracleCache: this.oracleCache,
    });

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
      ttlContext: ttlContext ?? existing.ttlContext,
      evContext,
    });
  }

  async bootstrapWatchObligations(keys: string[]): Promise<void> {
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

  async refreshMappingFromWatchTargets(targets: ShadowWatchTarget[]): Promise<void> {
    const nextKeys = new Set<string>();
    for (const target of targets) {
      const key = String(target.key ?? '');
      if (!key) continue;
      nextKeys.add(key);
      const existing = this.candidatesByKey.get(key);
      this.candidatesByKey.set(key, {
        ...existing,
        key,
        obligationPubkey: key,
        ownerPubkey: target.ownerPubkey ?? existing?.ownerPubkey,
        healthRatio: target.healthRatio ?? existing?.healthRatio,
        healthRatioRaw: target.healthRatioRaw ?? existing?.healthRatioRaw,
        borrowValueUsd: target.borrowValueUsd ?? existing?.borrowValueUsd,
        collateralValueUsd: target.collateralValueUsd ?? existing?.collateralValueUsd,
        liquidationEligible: target.liquidationEligible ?? existing?.liquidationEligible,
        healthSource: target.healthSource ?? existing?.healthSource,
        healthSourceUsed: target.healthSourceUsed ?? existing?.healthSourceUsed,
        healthSourceVerified: target.healthSourceVerified ?? existing?.healthSourceVerified,
        repayReservePubkey: target.repayReservePubkey ?? existing?.repayReservePubkey,
        collateralReservePubkey: target.collateralReservePubkey ?? existing?.collateralReservePubkey,
        primaryBorrowMint: target.primaryBorrowMint ?? existing?.primaryBorrowMint,
        primaryCollateralMint: target.primaryCollateralMint ?? existing?.primaryCollateralMint,
        assets: target.assets ?? existing?.assets,
        ev: target.ev ?? existing?.ev,
        hazard: target.hazard ?? existing?.hazard,
        rankBucket: target.rankBucket ?? existing?.rankBucket,
        forecast: target.forecast ?? existing?.forecast,
      });
    }

    for (const key of Array.from(this.candidatesByKey.keys())) {
      if (!nextKeys.has(key)) this.candidatesByKey.delete(key);
    }
    for (const key of Array.from(this.decodedByKey.keys())) {
      if (!nextKeys.has(key)) this.decodedByKey.delete(key);
    }

    this.orchestrator.refreshMapping(
      targets.map((target) => ({
        key: target.key,
        assets: target.assets,
      })),
    );
  }

  async refreshMappingFromQueue(plans: FlashloanPlan[]): Promise<void> {
    await this.refreshMappingFromWatchTargets(
      plans.map((plan) => ({
        key: String(plan.key ?? ''),
        obligationPubkey: String(plan.key ?? ''),
        ownerPubkey: plan.ownerPubkey,
        assets: plan.assets,
        repayReservePubkey: plan.repayReservePubkey,
        collateralReservePubkey: plan.collateralReservePubkey,
        primaryBorrowMint: plan.repayMint,
        primaryCollateralMint: plan.collateralMint,
        borrowValueUsd: plan.amountUsd,
        liquidationEligible: plan.liquidationEligible,
        ev: plan.ev,
        hazard: plan.hazard,
      })),
    );
  }

  async bootstrapQueueObligations(keys: string[]): Promise<void> {
    await this.bootstrapWatchObligations(keys);
  }
}
