import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { applyKlendSdkVerificationToCandidates } from "../engine/applyKlendSdkVerification.js";
import type { ScoredObligation } from "../strategy/candidateSelector.js";

const verifyMock = vi.fn();

vi.mock("../engine/klendSdkVerifier.js", () => ({
  getKlendSdkVerifier: vi.fn(() => ({
    verify: verifyMock,
  })),
}));

function makeCandidate(key: string, healthRatio = 1.1): ScoredObligation {
  return {
    obligationPubkey: key,
    ownerPubkey: PublicKey.unique().toBase58(),
    healthRatio,
    healthRatioRaw: healthRatio,
    liquidationEligible: healthRatio < 1,
    borrowValueUsd: 100,
    collateralValueUsd: 90,
  };
}

describe("applyKlendSdkVerificationToCandidates", () => {
  beforeEach(() => {
    verifyMock.mockReset();
  });

  it("annotates verification fields for successful sdk responses", async () => {
    verifyMock.mockResolvedValue({
      ok: true,
      healthRatioSdk: 0.95,
      healthRatioSdkRaw: 0.95,
      borrowUsdAdjSdk: 100,
      collateralUsdAdjSdk: 95,
    });
    const candidates = [makeCandidate("a")];

    await applyKlendSdkVerificationToCandidates({
      candidates,
      env: {
        LIQSOL_RECOMPUTED_VERIFY_BACKEND: "klend-sdk",
        LIQSOL_RECOMPUTED_VERIFY_TOP_K: 1,
        LIQSOL_RECOMPUTED_VERIFY_CONCURRENCY: 1,
        LIQSOL_RECOMPUTED_VERIFY_TTL_MS: 15000,
        LIQSOL_HEALTH_SOURCE: "hybrid",
      } as any,
      marketPubkey: PublicKey.unique(),
      programId: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });

    expect(candidates[0].healthRatioVerified).toBe(0.95);
    expect(candidates[0].healthSourceVerified).toBe("klend-sdk");
    expect(candidates[0].liquidationEligibleVerified).toBe(true);
  });

  it("overwrites chosen fields when LIQSOL_HEALTH_SOURCE is recomputed", async () => {
    verifyMock.mockResolvedValue({
      ok: true,
      healthRatioSdk: 0.9,
      healthRatioSdkRaw: 0.9,
      borrowUsdAdjSdk: 120,
      collateralUsdAdjSdk: 108,
    });
    const candidates = [makeCandidate("a", 1.2)];

    await applyKlendSdkVerificationToCandidates({
      candidates,
      env: {
        LIQSOL_RECOMPUTED_VERIFY_BACKEND: "klend-sdk",
        LIQSOL_RECOMPUTED_VERIFY_TOP_K: 1,
        LIQSOL_RECOMPUTED_VERIFY_CONCURRENCY: 1,
        LIQSOL_RECOMPUTED_VERIFY_TTL_MS: 15000,
        LIQSOL_HEALTH_SOURCE: "recomputed",
      } as any,
      marketPubkey: PublicKey.unique(),
      programId: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });

    expect(candidates[0].healthRatio).toBe(0.9);
    expect(candidates[0].healthSourceUsed).toBe("klend-sdk");
    expect(candidates[0].healthSource).toBe("klend-sdk");
    expect(candidates[0].liquidationEligible).toBe(true);
    expect(candidates[0].borrowValueUsd).toBe(120);
    expect(candidates[0].collateralValueUsd).toBe(108);
  });

  it("respects bounded top-k verification", async () => {
    verifyMock.mockResolvedValue({
      ok: true,
      healthRatioSdk: 0.97,
      healthRatioSdkRaw: 0.97,
      borrowUsdAdjSdk: 100,
      collateralUsdAdjSdk: 97,
    });
    const candidates = [makeCandidate("a"), makeCandidate("b"), makeCandidate("c")];

    await applyKlendSdkVerificationToCandidates({
      candidates,
      env: {
        LIQSOL_RECOMPUTED_VERIFY_BACKEND: "klend-sdk",
        LIQSOL_RECOMPUTED_VERIFY_TOP_K: 2,
        LIQSOL_RECOMPUTED_VERIFY_CONCURRENCY: 1,
        LIQSOL_RECOMPUTED_VERIFY_TTL_MS: 15000,
        LIQSOL_HEALTH_SOURCE: "hybrid",
      } as any,
      marketPubkey: PublicKey.unique(),
      programId: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });

    expect(verifyMock).toHaveBeenCalledTimes(2);
    expect(candidates[0].healthRatioVerified).toBeDefined();
    expect(candidates[1].healthRatioVerified).toBeDefined();
    expect(candidates[2].healthRatioVerified).toBeUndefined();
  });
});
