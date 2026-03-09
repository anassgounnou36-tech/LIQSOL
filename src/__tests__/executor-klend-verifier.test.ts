import { describe, expect, it, vi } from "vitest";
import { applyKlendSdkNearReadyGate } from "../execute/executor.js";
import {
  getPlanCooldownAnchorMs,
  setKlendHealthyCooldown,
  shouldSkipForKlendHealthyCooldown,
} from "../execute/klendHealthyCooldown.js";

function makePlan(key: string, ev: number, ttlMin = 1) {
  return {
    planVersion: 2,
    key,
    ownerPubkey: key,
    obligationPubkey: key,
    repayMint: key,
    collateralMint: key,
    mint: "USDC",
    amountUsd: 10,
    ev,
    hazard: 0.1,
    ttlMin,
    ttlComputedAtMs: Date.now(),
    ttlComputedMin: ttlMin,
    createdAtMs: Date.now(),
  };
}

describe("executor klend near-ready gate", () => {
  it("promotes too-early near-ready plan when sdk hr < 1", async () => {
    const nearReadyPlan = makePlan("A", 10, 1);
    const result = await applyKlendSdkNearReadyGate({
      candidates: [],
      tooEarlyNearReadyCandidates: [{ plan: nearReadyPlan, ttlRemainingMin: 1 }],
      gateEnabled: true,
      verifyWindowMin: 2,
      verifyTopK: 3,
      verifyFn: vi.fn().mockResolvedValue({
        promoted: true,
        reason: "eligible",
        healthRatioSdk: 0.9,
      }),
    });

    expect(result.map((p) => p.obligationPubkey)).toContain("A");
  });

  it("keeps too-early near-ready plan skipped when sdk hr >= 1", async () => {
    const nearReadyPlan = makePlan("A", 10, 1);
    const result = await applyKlendSdkNearReadyGate({
      candidates: [],
      tooEarlyNearReadyCandidates: [{ plan: nearReadyPlan, ttlRemainingMin: 1 }],
      gateEnabled: true,
      verifyWindowMin: 2,
      verifyTopK: 3,
      verifyFn: vi.fn().mockResolvedValue({
        promoted: false,
        reason: "healthy",
        healthRatioSdk: 1.1,
      }),
    });

    expect(result).toHaveLength(0);
  });

  it("verifies only top EXEC_KLEND_VERIFY_TOPK too-early plans by EV", async () => {
    const verifyFn = vi.fn().mockResolvedValue({
      promoted: false,
      reason: "healthy",
      healthRatioSdk: 1.05,
    });
    await applyKlendSdkNearReadyGate({
      candidates: [],
      tooEarlyNearReadyCandidates: [
        { plan: makePlan("A", 10), ttlRemainingMin: 1.5 },
        { plan: makePlan("B", 30), ttlRemainingMin: 1.5 },
        { plan: makePlan("C", 20), ttlRemainingMin: 1.5 },
      ],
      gateEnabled: true,
      verifyWindowMin: 2,
      verifyTopK: 2,
      verifyFn,
    });

    expect(verifyFn).toHaveBeenCalledTimes(2);
    expect(verifyFn.mock.calls[0][0].plan.obligationPubkey).toBe("B");
    expect(verifyFn.mock.calls[1][0].plan.obligationPubkey).toBe("C");
  });

  it("does nothing when gate is disabled", async () => {
    const verifyFn = vi.fn();
    const result = await applyKlendSdkNearReadyGate({
      candidates: [],
      tooEarlyNearReadyCandidates: [{ plan: makePlan("A", 10), ttlRemainingMin: 1 }],
      gateEnabled: false,
      verifyWindowMin: 2,
      verifyTopK: 3,
      verifyFn,
    });
    expect(result).toHaveLength(0);
    expect(verifyFn).not.toHaveBeenCalled();
  });
});

describe("executor klend healthy cooldown", () => {
  it("healthy verifier result sets cooldown", () => {
    const map = new Map();
    const plan = makePlan("A", 10, 1);
    const nowMs = 1_000;
    const anchorMs = getPlanCooldownAnchorMs(plan);
    setKlendHealthyCooldown(map, plan.key, anchorMs, nowMs, 15_000, 1.03);

    const active = shouldSkipForKlendHealthyCooldown(map, plan.key, anchorMs, nowMs + 1);
    expect(active?.healthRatioSdk).toBeCloseTo(1.03);
    expect(active?.untilMs).toBe(nowMs + 15_000);
  });

  it("same plan is skipped before cooldown expiry when anchor is unchanged", () => {
    const map = new Map();
    const plan = makePlan("A", 10, 1);
    const nowMs = 5_000;
    const anchorMs = getPlanCooldownAnchorMs(plan);
    setKlendHealthyCooldown(map, plan.key, anchorMs, nowMs, 3_000, 1.05);

    const active = shouldSkipForKlendHealthyCooldown(map, plan.key, anchorMs, nowMs + 2_500);
    expect(active).toBeDefined();
  });

  it("changed anchor invalidates cooldown", () => {
    const map = new Map();
    const plan = makePlan("A", 10, 1);
    const nowMs = 5_000;
    const anchorMs = getPlanCooldownAnchorMs(plan);
    setKlendHealthyCooldown(map, plan.key, anchorMs, nowMs, 3_000, 1.05);

    const changedAnchorMs = anchorMs + 1;
    const active = shouldSkipForKlendHealthyCooldown(map, plan.key, changedAnchorMs, nowMs + 500);
    expect(active).toBeUndefined();
  });

  it("promoted result does not set cooldown", () => {
    const map = new Map();
    const plan = makePlan("A", 10, 1);
    const nowMs = 5_000;
    const anchorMs = getPlanCooldownAnchorMs(plan);
    const promoted = true;
    if (!promoted) {
      setKlendHealthyCooldown(map, plan.key, anchorMs, nowMs, 3_000, 0.99);
    }

    const active = shouldSkipForKlendHealthyCooldown(map, plan.key, anchorMs, nowMs + 1);
    expect(active).toBeUndefined();
  });
});
