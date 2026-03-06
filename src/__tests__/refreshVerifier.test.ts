import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { clearRefreshVerifyCache, verifyPlanAfterRefresh } from "../execute/refreshVerifier.js";
import type { FlashloanPlan } from "../scheduler/txBuilder.js";

vi.mock("../kamino/canonicalLiquidationIxs.js", () => ({
  buildKaminoRefreshAndLiquidateIxsCanonical: vi.fn().mockResolvedValue({
    instructions: [{}, {}, {}],
    labels: ["refresh", "refreshObligation", "liquidate"],
  }),
}));

vi.mock("../execute/versionedTx.js", () => ({
  buildVersionedTx: vi.fn().mockResolvedValue({}),
}));

vi.mock("../kamino/decoder.js", () => ({
  decodeObligation: vi.fn(),
}));

vi.mock("../math/protocolHealth.js", () => ({
  computeProtocolHealth: vi.fn(),
}));

function makePlan(): FlashloanPlan {
  return {
    planVersion: 2,
    key: "obligation",
    obligationPubkey: Keypair.generate().publicKey.toBase58(),
    mint: "USDC",
    amountUsd: 10,
    repayMint: Keypair.generate().publicKey.toBase58(),
    collateralMint: Keypair.generate().publicKey.toBase58(),
    ev: 1,
    hazard: 0.1,
    ttlMin: 1,
    createdAtMs: Date.now(),
    ttlComputedAtMs: Date.now(),
    ttlComputedMin: 1,
  };
}

function makeEnv() {
  return {
    EXEC_REFRESH_VERIFY_CACHE_MS: "750",
    PRE_RESERVE_REFRESH_MODE: "auto",
  } as any;
}

describe("refreshVerifier", () => {
  const signer = Keypair.generate();
  const market = Keypair.generate().publicKey;
  const programId = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

  beforeEach(() => {
    vi.clearAllMocks();
    clearRefreshVerifyCache();
  });

  it("returns healthy for custom 6016 simulation result", async () => {
    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "bh" }),
      simulateTransaction: vi.fn().mockResolvedValue({
        context: { slot: 11 },
        value: { err: { InstructionError: [0, { Custom: 6016 }] }, accounts: [] },
      }),
    } as any;

    const result = await verifyPlanAfterRefresh({
      connection,
      signer,
      market,
      programId,
      plan: makePlan(),
      env: makeEnv(),
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("healthy");
  });

  it("returns eligible when protocol health ratio after refresh is below 1", async () => {
    const { decodeObligation } = await import("../kamino/decoder.js");
    const { computeProtocolHealth } = await import("../math/protocolHealth.js");
    vi.mocked(decodeObligation).mockReturnValue({} as any);
    vi.mocked(computeProtocolHealth).mockReturnValue({
      scored: true,
      healthRatio: 0.8,
    } as any);

    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "bh" }),
      simulateTransaction: vi.fn().mockResolvedValue({
        context: { slot: 22 },
        value: {
          err: null,
          accounts: [{ data: [Buffer.from("ok").toString("base64"), "base64"] }],
        },
      }),
    } as any;

    const result = await verifyPlanAfterRefresh({
      connection,
      signer,
      market,
      programId,
      plan: makePlan(),
      env: makeEnv(),
    });

    expect(result.eligible).toBe(true);
    expect(result.reason).toBe("eligible");
    expect(result.healthRatioAfterRefresh).toBe(0.8);
  });

  it("returns missing-account-data when simulation omits obligation account", async () => {
    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "bh" }),
      simulateTransaction: vi.fn().mockResolvedValue({
        context: { slot: 33 },
        value: { err: null, accounts: [] },
      }),
    } as any;

    const result = await verifyPlanAfterRefresh({
      connection,
      signer,
      market,
      programId,
      plan: makePlan(),
      env: makeEnv(),
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("missing-account-data");
  });

  it("uses cache to prevent immediate duplicate simulations for same verification key", async () => {
    const { decodeObligation } = await import("../kamino/decoder.js");
    const { computeProtocolHealth } = await import("../math/protocolHealth.js");
    vi.mocked(decodeObligation).mockReturnValue({} as any);
    vi.mocked(computeProtocolHealth).mockReturnValue({
      scored: true,
      healthRatio: 0.7,
    } as any);

    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "bh" }),
      simulateTransaction: vi.fn().mockResolvedValue({
        context: { slot: 44 },
        value: {
          err: null,
          accounts: [{ data: [Buffer.from("ok").toString("base64"), "base64"] }],
        },
      }),
    } as any;
    const plan = makePlan();

    const first = await verifyPlanAfterRefresh({
      connection,
      signer,
      market,
      programId,
      plan,
      env: makeEnv(),
    });
    const second = await verifyPlanAfterRefresh({
      connection,
      signer,
      market,
      programId,
      plan,
      env: makeEnv(),
    });

    expect(first.eligible).toBe(true);
    expect(second.eligible).toBe(true);
    expect(connection.simulateTransaction).toHaveBeenCalledTimes(1);
  });
});
