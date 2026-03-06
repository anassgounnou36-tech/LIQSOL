import { describe, expect, it, vi } from "vitest";
import { applyKlendSdkNearReadyGate } from "../execute/executor.js";

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

