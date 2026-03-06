import { PublicKey } from "@solana/web3.js";
import { isLiquidatable } from "../math/liquidation.js";
import { getKlendSdkVerifier } from "./klendSdkVerifier.js";
import type { ScoredObligation } from "../strategy/candidateSelector.js";
import type { Env, ReadonlyEnv } from "../config/env.js";

type VerificationEnv = Pick<
  Env & ReadonlyEnv,
  | "LIQSOL_RECOMPUTED_VERIFY_BACKEND"
  | "LIQSOL_RECOMPUTED_VERIFY_TOP_K"
  | "LIQSOL_RECOMPUTED_VERIFY_CONCURRENCY"
  | "LIQSOL_RECOMPUTED_VERIFY_TTL_MS"
  | "LIQSOL_HEALTH_SOURCE"
>;

export async function applyKlendSdkVerificationToCandidates(args: {
  candidates: ScoredObligation[];
  env: VerificationEnv;
  marketPubkey: PublicKey;
  programId: PublicKey;
  rpcUrl: string;
}): Promise<void> {
  const { candidates, env, marketPubkey, programId, rpcUrl } = args;
  if (env.LIQSOL_RECOMPUTED_VERIFY_BACKEND !== "klend-sdk") {
    return;
  }

  const verifier = getKlendSdkVerifier({
    rpcUrl,
    marketPubkey,
    programId,
    cacheTtlMs: Math.max(1, Number(env.LIQSOL_RECOMPUTED_VERIFY_TTL_MS)),
  });
  const verifyTopK = Math.max(
    0,
    Math.min(candidates.length, Number(env.LIQSOL_RECOMPUTED_VERIFY_TOP_K))
  );
  const verifyConcurrency = Math.max(
    1,
    Number(env.LIQSOL_RECOMPUTED_VERIFY_CONCURRENCY)
  );
  const verifyQueue = candidates.slice(0, verifyTopK);
  let verifyCursor = 0;

  await Promise.all(
    Array.from(
      { length: Math.min(verifyConcurrency, verifyQueue.length) },
      async () => {
        while (verifyCursor < verifyQueue.length) {
          const idx = verifyCursor++;
          const candidate = verifyQueue[idx];
          if (!candidate.ownerPubkey || !candidate.obligationPubkey) continue;

          const verification = await verifier.verify({
            obligationPubkey: candidate.obligationPubkey,
            ownerPubkey: candidate.ownerPubkey,
          });
          if (!verification.ok) continue;

          candidate.healthRatioVerified = verification.healthRatioSdk;
          candidate.healthRatioVerifiedRaw = verification.healthRatioSdkRaw;
          candidate.healthSourceVerified = "klend-sdk";
          candidate.borrowUsdAdjVerified = verification.borrowUsdAdjSdk;
          candidate.collateralUsdAdjVerified = verification.collateralUsdAdjSdk;
          candidate.liquidationEligibleVerified = isLiquidatable(
            verification.healthRatioSdk
          );

          if (env.LIQSOL_HEALTH_SOURCE === "recomputed") {
            candidate.healthRatio = verification.healthRatioSdk;
            candidate.healthRatioRaw = verification.healthRatioSdkRaw;
            candidate.liquidationEligible = !!candidate.liquidationEligibleVerified;
            candidate.borrowValueUsd = verification.borrowUsdAdjSdk;
            candidate.collateralValueUsd = verification.collateralUsdAdjSdk;
            candidate.healthSourceUsed = "klend-sdk";
            candidate.healthSource = "klend-sdk";
          }
        }
      }
    )
  );
}

