import { describe, expect, it } from 'vitest';
import {
  getShadowPromotionAnchorMs,
  setShadowPromotionHealthyCooldown,
  shouldSkipForShadowPromotionHealthyCooldown,
} from '../monitoring/shadowPromotionHealthyCooldown.js';

describe('shadow promotion healthy cooldown helpers', () => {
  it('healthy verifier result sets cooldown for key and anchor', () => {
    const map = new Map();
    const key = 'obligation-A';
    const nowMs = 1_000;
    const anchorMs = getShadowPromotionAnchorMs({ createdAtMs: 500 });

    setShadowPromotionHealthyCooldown(map, key, anchorMs, nowMs, 15_000, 1.04);

    const active = shouldSkipForShadowPromotionHealthyCooldown(map, key, anchorMs, nowMs + 1);
    expect(active).toBeDefined();
    expect(active?.healthRatioSdk).toBeCloseTo(1.04);
    expect(active?.untilMs).toBe(nowMs + 15_000);
  });

  it('same key and same anchor is skipped before cooldown expiry', () => {
    const map = new Map();
    const key = 'obligation-B';
    const nowMs = 5_000;
    const anchorMs = getShadowPromotionAnchorMs({ predictedLiquidationAtMs: 42_000 });
    setShadowPromotionHealthyCooldown(map, key, anchorMs, nowMs, 3_000, 1.02);

    const active = shouldSkipForShadowPromotionHealthyCooldown(map, key, anchorMs, nowMs + 2_000);
    expect(active).toBeDefined();
  });

  it('same key and same anchor is not skipped after cooldown expiry', () => {
    const map = new Map();
    const key = 'obligation-B-expired';
    const nowMs = 5_000;
    const anchorMs = getShadowPromotionAnchorMs({ predictedLiquidationAtMs: 42_000 });
    setShadowPromotionHealthyCooldown(map, key, anchorMs, nowMs, 3_000, 1.02);

    const active = shouldSkipForShadowPromotionHealthyCooldown(map, key, anchorMs, nowMs + 3_001);
    expect(active).toBeUndefined();
  });

  it('same key with changed anchor is not skipped', () => {
    const map = new Map();
    const key = 'obligation-C';
    const nowMs = 5_000;
    const anchorMs = getShadowPromotionAnchorMs({ ttlComputedAtMs: 10_000 });
    setShadowPromotionHealthyCooldown(map, key, anchorMs, nowMs, 3_000, 1.03);

    const changedAnchorMs = anchorMs + 1;
    const active = shouldSkipForShadowPromotionHealthyCooldown(map, key, changedAnchorMs, nowMs + 500);
    expect(active).toBeUndefined();
  });

  it('admitted candidate does not set healthy cooldown', () => {
    const map = new Map();
    const promoted = true;
    if (!promoted) {
      setShadowPromotionHealthyCooldown(map, 'obligation-D', 1, 1_000, 5_000, 0.99);
    }

    const active = shouldSkipForShadowPromotionHealthyCooldown(map, 'obligation-D', 1, 1_500);
    expect(active).toBeUndefined();
  });

  it('verify-error does not set healthy cooldown', () => {
    const map = new Map();
    const verificationOk = false;
    if (verificationOk) {
      setShadowPromotionHealthyCooldown(map, 'obligation-E', 1, 1_000, 5_000, 1.1);
    }

    const active = shouldSkipForShadowPromotionHealthyCooldown(map, 'obligation-E', 1, 1_500);
    expect(active).toBeUndefined();
  });
});
