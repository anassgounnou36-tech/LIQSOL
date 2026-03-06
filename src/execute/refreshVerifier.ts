import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { FlashloanPlan } from "../scheduler/txBuilder.js";
import { buildKaminoRefreshAndLiquidateIxsCanonical } from "../kamino/canonicalLiquidationIxs.js";
import { buildVersionedTx } from "./versionedTx.js";
import { decodeObligation } from "../kamino/decoder.js";
import { computeProtocolHealth } from "../math/protocolHealth.js";
import type { Env } from "../config/env.js";

export type RefreshVerifyReason =
  | "eligible"
  | "healthy"
  | "simulation-error"
  | "decode-failed"
  | "missing-account-data";

export interface RefreshVerifyResult {
  eligible: boolean;
  healthRatioAfterRefresh: number | null;
  reason: RefreshVerifyReason;
  slot?: number;
}

const refreshVerifyCache = new Map<
  string,
  { expiresAtMs: number; result: RefreshVerifyResult }
>();

function extractCustomCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object" || !("InstructionError" in err)) return undefined;
  const instructionError = (err as { InstructionError?: unknown }).InstructionError as unknown[] | undefined;
  const innerError = instructionError?.[1];
  if (innerError && typeof innerError === "object" && "Custom" in innerError) {
    return (innerError as { Custom?: number }).Custom;
  }
  return undefined;
}

function getCacheKey(plan: FlashloanPlan): string {
  const ttlAnchor = Number(plan.ttlComputedAtMs ?? 0);
  const predictedAt = Number(plan.predictedLiquidationAtMs ?? 0);
  return `${plan.obligationPubkey}:${ttlAnchor}:${predictedAt}`;
}

function decodePostSimObligationAccount(
  accountDataField: unknown
): Buffer | null {
  if (!accountDataField || typeof accountDataField !== "object" || !("data" in accountDataField)) {
    return null;
  }
  const data = (accountDataField as { data?: unknown }).data;
  if (!Array.isArray(data) || typeof data[0] !== "string") {
    return null;
  }
  return Buffer.from(data[0], "base64");
}

export function clearRefreshVerifyCache(): void {
  refreshVerifyCache.clear();
}

export async function verifyPlanAfterRefresh(args: {
  connection: Connection;
  signer: Keypair;
  market: PublicKey;
  programId: PublicKey;
  plan: FlashloanPlan;
  env: Env;
}): Promise<RefreshVerifyResult> {
  const { connection, signer, market, programId, plan, env } = args;
  if (!plan?.obligationPubkey) {
    throw new Error("verifyPlanAfterRefresh requires plan.obligationPubkey");
  }

  const cacheMs = Math.max(0, Number(env.EXEC_REFRESH_VERIFY_CACHE_MS ?? "750"));
  const key = getCacheKey(plan);
  const nowMs = Date.now();
  const cached = refreshVerifyCache.get(key);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.result;
  }

  const canonical = await buildKaminoRefreshAndLiquidateIxsCanonical({
    connection,
    signer,
    marketPubkey: market,
    programId,
    obligationPubkey: new PublicKey(plan.obligationPubkey),
    cuLimit: Number(process.env.EXEC_CU_LIMIT ?? 600_000),
    cuPrice: Number(process.env.EXEC_CU_PRICE ?? 0),
    repayMintPreference: plan.repayMint ? new PublicKey(plan.repayMint) : undefined,
    repayAmountUi: plan.amountUi,
    expectedRepayReservePubkey: plan.repayReservePubkey ? new PublicKey(plan.repayReservePubkey) : undefined,
    expectedCollateralReservePubkey: plan.collateralReservePubkey ? new PublicKey(plan.collateralReservePubkey) : undefined,
    preReserveRefreshMode: env.PRE_RESERVE_REFRESH_MODE,
    flashloan: undefined,
    swap: undefined,
  });

  const liquidateIndex = canonical.labels.findIndex((label) => label === "liquidate");
  if (liquidateIndex <= 0) {
    throw new Error("verifyPlanAfterRefresh expected canonical liquidate instruction");
  }
  const refreshPrefix = canonical.instructions.slice(0, liquidateIndex);
  if (refreshPrefix.length === 0) {
    throw new Error("verifyPlanAfterRefresh refresh prefix is empty");
  }

  const bh = await connection.getLatestBlockhash();
  const refreshTx = await buildVersionedTx({
    payer: signer.publicKey,
    blockhash: bh.blockhash,
    instructions: refreshPrefix,
    signer,
  });

  const sim = await connection.simulateTransaction(refreshTx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    accounts: { addresses: [plan.obligationPubkey], encoding: "base64" },
  });

  if (sim.value.err) {
    const customCode = extractCustomCode(sim.value.err);
    const result: RefreshVerifyResult =
      customCode === 6016
        ? { eligible: false, healthRatioAfterRefresh: null, reason: "healthy", slot: sim.context?.slot }
        : { eligible: false, healthRatioAfterRefresh: null, reason: "simulation-error", slot: sim.context?.slot };
    refreshVerifyCache.set(key, { expiresAtMs: nowMs + cacheMs, result });
    return result;
  }

  const obligationAccountData = sim.value.accounts?.[0];
  const obligationRaw = decodePostSimObligationAccount(obligationAccountData);
  if (!obligationRaw) {
    const result: RefreshVerifyResult = {
      eligible: false,
      healthRatioAfterRefresh: null,
      reason: "missing-account-data",
      slot: sim.context?.slot,
    };
    refreshVerifyCache.set(key, { expiresAtMs: nowMs + cacheMs, result });
    return result;
  }

  try {
    const decoded = decodeObligation(obligationRaw, new PublicKey(plan.obligationPubkey));
    const protocol = computeProtocolHealth(decoded);
    if (!protocol.scored) {
      const result: RefreshVerifyResult = {
        eligible: false,
        healthRatioAfterRefresh: null,
        reason: "decode-failed",
        slot: sim.context?.slot,
      };
      refreshVerifyCache.set(key, { expiresAtMs: nowMs + cacheMs, result });
      return result;
    }
    const healthRatioAfterRefresh = protocol.healthRatio;
    const result: RefreshVerifyResult = {
      eligible: healthRatioAfterRefresh < 1,
      healthRatioAfterRefresh,
      reason: healthRatioAfterRefresh < 1 ? "eligible" : "healthy",
      slot: sim.context?.slot,
    };
    refreshVerifyCache.set(key, { expiresAtMs: nowMs + cacheMs, result });
    return result;
  } catch {
    const result: RefreshVerifyResult = {
      eligible: false,
      healthRatioAfterRefresh: null,
      reason: "decode-failed",
      slot: sim.context?.slot,
    };
    refreshVerifyCache.set(key, { expiresAtMs: nowMs + cacheMs, result });
    return result;
  }
}
