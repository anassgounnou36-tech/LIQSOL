import fs from 'node:fs';
import path from 'node:path';
import { loadQueue } from '../scheduler/txScheduler.js';

export interface ShadowWatchTarget {
  key: string;
  obligationPubkey: string;
  ownerPubkey?: string;
  assets?: string[];
  repayReservePubkey?: string;
  collateralReservePubkey?: string;
  primaryBorrowMint?: string;
  primaryCollateralMint?: string;
  healthRatio?: number;
  healthRatioRaw?: number;
  borrowValueUsd?: number;
  collateralValueUsd?: number;
  liquidationEligible?: boolean;
  healthSource?: string;
  healthSourceUsed?: string;
  healthSourceVerified?: string;
  ev?: number;
  hazard?: number;
  rankBucket?: 'liquidatable' | 'near-ready' | 'medium-horizon' | 'far-horizon' | 'legacy-or-unknown';
  forecast?: {
    ttlMinutes?: number | null;
    timeToLiquidation?: string;
    model?: string;
  };
}

export interface LoadShadowWatchTargetsResult {
  queueTargets: ShadowWatchTarget[];
  shadowOnlyTargets: ShadowWatchTarget[];
  allTargets: ShadowWatchTarget[];
}

function normalizeCandidatesPayload(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const value = payload as Record<string, unknown>;
  if (Array.isArray(value.candidates)) return value.candidates;
  if (Array.isArray(value.data)) return value.data;
  return Object.values(value);
}

function toShadowWatchTarget(raw: any): ShadowWatchTarget | null {
  const key = String(raw?.key ?? raw?.obligationPubkey ?? '');
  if (!key) return null;
  return {
    key,
    obligationPubkey: String(raw?.obligationPubkey ?? key),
    ownerPubkey: raw?.ownerPubkey,
    assets: Array.isArray(raw?.assets) ? raw.assets : undefined,
    repayReservePubkey: raw?.repayReservePubkey,
    collateralReservePubkey: raw?.collateralReservePubkey,
    primaryBorrowMint: raw?.primaryBorrowMint ?? raw?.repayMint ?? raw?.borrowMint,
    primaryCollateralMint: raw?.primaryCollateralMint ?? raw?.collateralMint,
    healthRatio: raw?.healthRatio != null ? Number(raw.healthRatio) : undefined,
    healthRatioRaw: raw?.healthRatioRaw != null ? Number(raw.healthRatioRaw) : undefined,
    borrowValueUsd: raw?.borrowValueUsd != null ? Number(raw.borrowValueUsd) : raw?.amountUsd != null ? Number(raw.amountUsd) : undefined,
    collateralValueUsd: raw?.collateralValueUsd != null ? Number(raw.collateralValueUsd) : undefined,
    liquidationEligible: raw?.liquidationEligible === true,
    healthSource: raw?.healthSource,
    healthSourceUsed: raw?.healthSourceUsed,
    healthSourceVerified: raw?.healthSourceVerified,
    ev: raw?.ev != null ? Number(raw.ev) : undefined,
    hazard: raw?.hazard != null ? Number(raw.hazard) : undefined,
    rankBucket: raw?.rankBucket,
    forecast: raw?.forecast
      ? {
          ttlMinutes:
            raw.forecast?.ttlMinutes != null
              ? Number(raw.forecast.ttlMinutes)
              : raw.forecast?.ttlMinutes,
          timeToLiquidation: raw.forecast?.timeToLiquidation,
          model: raw.forecast?.model,
        }
      : undefined,
  };
}

function loadCandidates(): ShadowWatchTarget[] {
  const candidatesPath = path.join(process.cwd(), 'data', 'candidates.json');
  if (!fs.existsSync(candidatesPath)) return [];
  try {
    const payload = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
    return normalizeCandidatesPayload(payload).map(toShadowWatchTarget).filter(Boolean) as ShadowWatchTarget[];
  } catch {
    return [];
  }
}

export function loadShadowWatchTargets(): LoadShadowWatchTargetsResult {
  const queueTargets = loadQueue()
    .map(toShadowWatchTarget)
    .filter(Boolean) as ShadowWatchTarget[];

  const queueKeys = new Set(queueTargets.map((t) => t.key));
  const includeMediumHorizon = (process.env.SHADOW_WATCH_INCLUDE_MEDIUM_HORIZON ?? 'true') === 'true';
  const maxTtlMin = Number(process.env.SHADOW_WATCH_MAX_TTL_MIN ?? '60');
  const topK = Math.max(0, Number(process.env.SHADOW_WATCH_TOPK ?? '50'));

  const shadowOnlyTargets: ShadowWatchTarget[] = [];
  for (const candidate of loadCandidates()) {
    if (queueKeys.has(candidate.key)) continue;
    const bucket = candidate.rankBucket ?? 'legacy-or-unknown';
    if (bucket === 'far-horizon' || bucket === 'legacy-or-unknown') continue;
    if (bucket === 'medium-horizon' && !includeMediumHorizon) continue;

    const ttlMinutes = candidate.forecast?.ttlMinutes;
    if (Number.isFinite(ttlMinutes) && Number(ttlMinutes) > maxTtlMin) continue;

    shadowOnlyTargets.push(candidate);
    if (shadowOnlyTargets.length >= topK) break;
  }

  const allTargetsMap = new Map<string, ShadowWatchTarget>();
  for (const target of queueTargets) {
    allTargetsMap.set(target.key, target);
  }
  for (const target of shadowOnlyTargets) {
    if (!allTargetsMap.has(target.key)) {
      allTargetsMap.set(target.key, target);
    }
  }

  return {
    queueTargets,
    shadowOnlyTargets,
    allTargets: Array.from(allTargetsMap.values()),
  };
}
