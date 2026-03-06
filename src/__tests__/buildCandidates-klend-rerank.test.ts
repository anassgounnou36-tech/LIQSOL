import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { ScoredObligation } from "../strategy/candidateSelector.js";

const applyMock = vi.fn();

vi.mock("../engine/applyKlendSdkVerification.js", () => ({
  applyKlendSdkVerificationToCandidates: (...args: unknown[]) => applyMock(...args),
}));

function makeScored(
  obligationPubkey: string,
  healthRatio: number,
  borrowValueUsd = 100
): ScoredObligation {
  return {
    obligationPubkey,
    ownerPubkey: PublicKey.unique().toBase58(),
    healthRatio,
    healthRatioRaw: healthRatio,
    liquidationEligible: healthRatio < 1,
    borrowValueUsd,
    collateralValueUsd: borrowValueUsd * healthRatio,
    repayReservePubkey: PublicKey.unique().toBase58(),
    collateralReservePubkey: PublicKey.unique().toBase58(),
  };
}

describe("rankCandidatesWithBoundedKlendVerification", () => {
  it("re-ranks after bounded sdk mutation before slicing topN", async () => {
    const { rankCandidatesWithBoundedKlendVerification } = await import(
      "../pipeline/buildCandidates.js"
    );
    const candidatesWithBothLegs: ScoredObligation[] = [
      makeScored("best-initial", 1.01, 120),
      makeScored("becomes-best-after-sdk", 1.20, 90),
    ];

    applyMock.mockImplementation(async ({ candidates }: { candidates: ScoredObligation[] }) => {
      const target = candidates.find(
        (c) => c.obligationPubkey === "becomes-best-after-sdk"
      );
      if (target) {
        target.healthRatio = 0.9;
        target.healthRatioRaw = 0.9;
        target.liquidationEligible = true;
      }
    });

    const ranked = await rankCandidatesWithBoundedKlendVerification({
      candidatesWithBothLegs,
      nearThreshold: 1.02,
      topN: 1,
      env: {
        LIQSOL_RECOMPUTED_VERIFY_BACKEND: "klend-sdk",
        LIQSOL_RECOMPUTED_VERIFY_TOP_K: 3,
        LIQSOL_RECOMPUTED_VERIFY_CONCURRENCY: 1,
        LIQSOL_RECOMPUTED_VERIFY_TTL_MS: 15000,
        LIQSOL_HEALTH_SOURCE: "recomputed",
      } as any,
      marketPubkey: PublicKey.unique(),
      programId: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });

    expect(ranked.topCandidates[0].obligationPubkey).toBe("becomes-best-after-sdk");
  });
});
