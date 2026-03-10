export interface ShadowPromotionHealthyCooldownEntry {
  untilMs: number;
  anchorMs: number;
  healthRatioSdk: number;
}

export function getShadowPromotionAnchorMs(candidate: {
  forecast?: { ttlMinutes?: number | null };
  predictedLiquidationAtMs?: number | string | null;
  ttlComputedAtMs?: number | string | null;
  createdAtMs?: number | string | null;
}): number {
  const predictedLiquidationAtMs = Number(candidate.predictedLiquidationAtMs);
  if (Number.isFinite(predictedLiquidationAtMs)) return predictedLiquidationAtMs;

  const ttlComputedAtMs = Number(candidate.ttlComputedAtMs);
  if (Number.isFinite(ttlComputedAtMs)) return ttlComputedAtMs;

  const createdAtMs = Number(candidate.createdAtMs);
  if (Number.isFinite(createdAtMs)) return createdAtMs;

  return 0;
}

export function shouldSkipForShadowPromotionHealthyCooldown(
  map: Map<string, ShadowPromotionHealthyCooldownEntry>,
  key: string,
  currentAnchorMs: number,
  nowMs: number
): ShadowPromotionHealthyCooldownEntry | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (entry.anchorMs !== currentAnchorMs) return undefined;
  if (entry.untilMs <= nowMs) return undefined;
  return entry;
}

export function setShadowPromotionHealthyCooldown(
  map: Map<string, ShadowPromotionHealthyCooldownEntry>,
  key: string,
  anchorMs: number,
  nowMs: number,
  cooldownMs: number,
  healthRatioSdk: number
): void {
  map.set(key, {
    untilMs: nowMs + Math.max(0, cooldownMs),
    anchorMs,
    healthRatioSdk,
  });
}
