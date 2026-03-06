import { describe, expect, it, vi } from "vitest";
import { applyRefreshVerifierGate } from "../execute/executor.js";

function makePlan(key: string, ev: number, ttlMin = 1) {
  return {
    planVersion: 2,
    key,
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

describe("executor refresh verifier gate", () => {
  it("allows near-ready too-early plan through when verifier marks it eligible", async () => {
    const nearReadyPlan = makePlan("A", 10, 1);
    const result = await applyRefreshVerifierGate({
      candidates: [],
      tooEarlyNearReadyCandidates: [{ plan: nearReadyPlan, ttlRemainingMin: 1 }],
      refreshVerifyEnabled: true,
      refreshVerifyWindowMin: 5,
      refreshVerifyTopK: 3,
      verifyFn: vi.fn().mockResolvedValue({
        eligible: true,
        reason: "eligible",
        healthRatioAfterRefresh: 0.9,
      }),
    });

    expect(result.map((p) => p.obligationPubkey)).toContain("A");
  });

  it("keeps near-ready plan skipped when verifier returns healthy", async () => {
    const nearReadyPlan = makePlan("A", 10, 1);
    const result = await applyRefreshVerifierGate({
      candidates: [],
      tooEarlyNearReadyCandidates: [{ plan: nearReadyPlan, ttlRemainingMin: 1 }],
      refreshVerifyEnabled: true,
      refreshVerifyWindowMin: 5,
      refreshVerifyTopK: 3,
      verifyFn: vi.fn().mockResolvedValue({
        eligible: false,
        reason: "healthy",
        healthRatioAfterRefresh: 1.2,
      }),
    });

    expect(result).toHaveLength(0);
  });

  it("verifies only top EXEC_REFRESH_VERIFY_TOPK near-ready candidates by EV", async () => {
    const verifyFn = vi.fn().mockResolvedValue({
      eligible: false,
      reason: "healthy",
      healthRatioAfterRefresh: 1.1,
    });
    await applyRefreshVerifierGate({
      candidates: [],
      tooEarlyNearReadyCandidates: [
        { plan: makePlan("A", 10), ttlRemainingMin: 2 },
        { plan: makePlan("B", 30), ttlRemainingMin: 2 },
        { plan: makePlan("C", 20), ttlRemainingMin: 2 },
      ],
      refreshVerifyEnabled: true,
      refreshVerifyWindowMin: 5,
      refreshVerifyTopK: 2,
      verifyFn,
    });

    expect(verifyFn).toHaveBeenCalledTimes(2);
    expect(verifyFn.mock.calls[0][0].plan.obligationPubkey).toBe("B");
    expect(verifyFn.mock.calls[1][0].plan.obligationPubkey).toBe("C");
  });
});
