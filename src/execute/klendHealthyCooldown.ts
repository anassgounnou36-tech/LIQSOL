export interface KlendHealthyCooldownEntry {
  untilMs: number;
  anchorMs: number;
  healthRatioSdk: number;
}

export function getPlanCooldownAnchorMs(plan: {
  predictedLiquidationAtMs?: number | string | null;
  ttlComputedAtMs?: number | string | null;
  createdAtMs?: number | string | null;
}): number {
  const predictedLiquidationAtMs = Number(plan.predictedLiquidationAtMs);
  if (Number.isFinite(predictedLiquidationAtMs)) return predictedLiquidationAtMs;

  const ttlComputedAtMs = Number(plan.ttlComputedAtMs);
  if (Number.isFinite(ttlComputedAtMs)) return ttlComputedAtMs;

  const createdAtMs = Number(plan.createdAtMs);
  if (Number.isFinite(createdAtMs)) return createdAtMs;

  return 0;
}

export function shouldSkipForKlendHealthyCooldown(
  map: Map<string, KlendHealthyCooldownEntry>,
  planKey: string,
  currentAnchorMs: number,
  nowMs: number
): KlendHealthyCooldownEntry | undefined {
  const entry = map.get(planKey);
  if (!entry) return undefined;
  if (entry.anchorMs !== currentAnchorMs) return undefined;
  if (entry.untilMs <= nowMs) return undefined;
  return entry;
}

export function setKlendHealthyCooldown(
  map: Map<string, KlendHealthyCooldownEntry>,
  planKey: string,
  anchorMs: number,
  nowMs: number,
  cooldownMs: number,
  healthRatioSdk: number
): void {
  map.set(planKey, {
    untilMs: nowMs + Math.max(0, cooldownMs),
    anchorMs,
    healthRatioSdk,
  });
}
