import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import type { BuiltPlanTx } from "../execute/planTxBuilder.js";
import {
  runLandingEdgeValidationWithPlan,
  type LandingEdgeValidationDeps,
  type CliArgs,
} from "../commands/validateLandingEdge.js";

function makeIx(): TransactionInstruction {
  return new TransactionInstruction({
    keys: [],
    programId: Keypair.generate().publicKey,
    data: Buffer.alloc(0),
  });
}

function makeDeps(overrides: Partial<LandingEdgeValidationDeps> = {}): LandingEdgeValidationDeps {
  const baseIx = makeIx();
  const transferIx = SystemProgram.transfer({
    fromPubkey: Keypair.generate().publicKey,
    toPubkey: Keypair.generate().publicKey,
    lamports: 1,
  });
  return {
    buildPreLiquidationValidationPath: vi.fn().mockResolvedValue({
      instructions: [baseIx],
      labels: ["refreshObligation"],
      source: "pre-liquidation-refresh",
    }),
    buildPlanTransactions: vi.fn().mockResolvedValue({
      setupIxs: [],
      setupLabels: [],
      missingAtas: [],
      mainIxs: [baseIx],
      mainLabels: ["main"],
      hasFarmsRefresh: false,
      hasPostFarmsRefresh: false,
      farmRequiredModes: [],
      swapIxs: [],
      swapLookupTables: [],
      atomicIxs: [baseIx],
      atomicLabels: ["atomic"],
      atomicLookupTables: [],
      repayMint: PublicKey.default,
      collateralMint: PublicKey.default,
      withdrawCollateralMint: PublicKey.default,
      swapRequired: false,
      swapReady: true,
    } as BuiltPlanTx),
    quotePriorityFeeMicroLamports: vi.fn().mockResolvedValue({
      mode: "recent-fees",
      writableAccountsSampled: 2,
      observedSamples: 1,
      observedNonZeroSamples: 1,
      recommendedMicroLamports: 55,
    }),
    fetchJitoTipAccounts: vi.fn().mockResolvedValue([Keypair.generate().publicKey.toBase58()]),
    withOptionalJitoTipInstruction: vi.fn().mockImplementation(async (args) => {
      return args.sendMode === "jito" ? [...args.instructions, transferIx] : args.instructions;
    }),
    buildVersionedTx: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

const cli: CliArgs = {
  json: false,
  strictJito: false,
  strictRecentFees: false,
};

const env = {
  EXEC_KLEND_HEALTHY_COOLDOWN_MS: "60000",
  EXEC_PRIORITY_FEE_MODE: "recent-fees",
  EXEC_PRIORITY_FEE_PERCENTILE: "75",
  EXEC_PRIORITY_FEE_FLOOR_MICROLAMPORTS: "0",
  EXEC_PRIORITY_FEE_CAP_MICROLAMPORTS: "100000",
  EXEC_PRIORITY_FEE_SAMPLE_ACCOUNTS_LIMIT: "32",
  JITO_TIP_LAMPORTS: "1000",
  JITO_BLOCK_ENGINE_BUNDLES_URL: "https://example.test",
  EXEC_SEND_MODE: "jito",
  JITO_BUNDLE_ONLY: "true",
} as any;

const selectedPlan = {
  key: "plan-a",
  obligationPubkey: Keypair.generate().publicKey.toBase58(),
  repayReservePubkey: Keypair.generate().publicKey.toBase58(),
  collateralReservePubkey: Keypair.generate().publicKey.toBase58(),
} as any;

describe("validateLandingEdge orchestration", () => {
  it("treats ordinary full-build repay-zero failure as WARN, not FAIL", async () => {
    const deps = makeDeps({
      buildPlanTransactions: vi.fn().mockRejectedValue(new Error("Derived repay amount is zero")),
    });
    const summary = await runLandingEdgeValidationWithPlan({
      cli,
      env,
      connection: { getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "bh" }) } as any,
      signer: Keypair.generate(),
      selectedPlan,
      market: Keypair.generate().publicKey,
      programId: Keypair.generate().publicKey,
      deps,
    });
    expect(summary.fullBuild).toBe("WARN");
    expect(summary.overall).toBe("WARN");
    expect(summary.fees).toBe("PASS");
  });

  it("runs pre-liquidation fee validation even when full build warns", async () => {
    const quote = vi.fn().mockResolvedValue({
      mode: "recent-fees",
      writableAccountsSampled: 1,
      observedSamples: 1,
      observedNonZeroSamples: 1,
      recommendedMicroLamports: 1,
    });
    const deps = makeDeps({
      buildPlanTransactions: vi.fn().mockRejectedValue(new Error("Borrow may be too small to liquidate")),
      quotePriorityFeeMicroLamports: quote as any,
    });
    const summary = await runLandingEdgeValidationWithPlan({
      cli,
      env,
      connection: { getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "bh" }) } as any,
      signer: Keypair.generate(),
      selectedPlan,
      market: Keypair.generate().publicKey,
      programId: Keypair.generate().publicKey,
      deps,
    });
    expect(quote).toHaveBeenCalled();
    expect(summary.feeResults.some((r) => r.pathLabel === "pre-liquidation-refresh")).toBe(true);
    expect(summary.fullBuild).toBe("WARN");
  });

  it("runs pre-liquidation jito validation even when full build warns", async () => {
    const fetchTips = vi.fn().mockResolvedValue([Keypair.generate().publicKey.toBase58()]);
    const withTip = vi.fn().mockImplementation(async (args) => args.instructions);
    const deps = makeDeps({
      buildPlanTransactions: vi.fn().mockRejectedValue(new Error("tx too large")),
      fetchJitoTipAccounts: fetchTips as any,
      withOptionalJitoTipInstruction: withTip as any,
    });
    const summary = await runLandingEdgeValidationWithPlan({
      cli,
      env: { ...env, JITO_TIP_LAMPORTS: "0" } as any,
      connection: { getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "bh" }) } as any,
      signer: Keypair.generate(),
      selectedPlan,
      market: Keypair.generate().publicKey,
      programId: Keypair.generate().publicKey,
      deps,
    });
    expect(fetchTips).toHaveBeenCalled();
    expect(withTip).toHaveBeenCalled();
    expect(summary.jito).toBe("PASS");
    expect(summary.fullBuild).toBe("WARN");
  });

  it("marks unexpected full-build exception as FAIL", async () => {
    const deps = makeDeps({
      buildPlanTransactions: vi.fn().mockRejectedValue(new Error("unexpected-kaboom")),
    });
    const summary = await runLandingEdgeValidationWithPlan({
      cli,
      env,
      connection: { getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "bh" }) } as any,
      signer: Keypair.generate(),
      selectedPlan,
      market: Keypair.generate().publicKey,
      programId: Keypair.generate().publicKey,
      deps,
    });
    expect(summary.fullBuild).toBe("FAIL");
    expect(summary.overall).toBe("FAIL");
  });

  it("keeps fullBuild status separate in summary", async () => {
    const deps = makeDeps({
      buildPlanTransactions: vi.fn().mockRejectedValue(new Error("Derived repay amount is zero")),
    });
    const summary = await runLandingEdgeValidationWithPlan({
      cli,
      env,
      connection: { getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "bh" }) } as any,
      signer: Keypair.generate(),
      selectedPlan,
      market: Keypair.generate().publicKey,
      programId: Keypair.generate().publicKey,
      deps,
    });
    expect(summary.fullBuild).toBe("WARN");
    expect(summary.fees).toBe("PASS");
    expect(summary.jito).toBe("PASS");
    expect(summary.fullBuildReason).toContain("Derived repay amount is zero");
  });
});

