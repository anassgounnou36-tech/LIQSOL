import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { BuiltPlanTx } from "../execute/planTxBuilder.js";
import {
  evaluateJitoTipMutation,
  extractValidationPaths,
  pickPrimaryValidationPath,
} from "../execute/landingEdgeValidation.js";

function makeIx(): TransactionInstruction {
  return new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: [],
    data: Buffer.alloc(0),
  });
}

function makeBuilt(overrides: Partial<BuiltPlanTx>): BuiltPlanTx {
  return {
    setupIxs: [],
    setupLabels: [],
    missingAtas: [],
    mainIxs: [],
    mainLabels: [],
    hasFarmsRefresh: false,
    hasPostFarmsRefresh: false,
    farmRequiredModes: [],
    swapIxs: [],
    swapLookupTables: [],
    atomicIxs: [],
    atomicLabels: [],
    atomicLookupTables: [],
    repayMint: PublicKey.default,
    collateralMint: PublicKey.default,
    withdrawCollateralMint: PublicKey.default,
    swapRequired: false,
    swapReady: true,
    ...overrides,
  };
}

describe("landing edge validation helpers", () => {
  it("extractValidationPaths includes only non-empty paths", () => {
    const built = makeBuilt({
      setupIxs: [makeIx()],
      setupLabels: ["setup"],
      mainIxs: [],
      mainLabels: [],
      atomicIxs: [makeIx()],
      atomicLabels: ["atomic"],
    });
    const paths = extractValidationPaths(built);
    expect(paths.map((path) => path.pathLabel)).toEqual(["setup-only", "atomic"]);
  });

  it("pickPrimaryValidationPath prefers atomic over main over setup-only", () => {
    expect(
      pickPrimaryValidationPath([
        { pathLabel: "setup-only", instructions: [makeIx()], labels: ["setup"] },
        { pathLabel: "main", instructions: [makeIx()], labels: ["main"] },
      ])?.pathLabel
    ).toBe("main");
    expect(
      pickPrimaryValidationPath([
        { pathLabel: "setup-only", instructions: [makeIx()], labels: ["setup"] },
        { pathLabel: "main", instructions: [makeIx()], labels: ["main"] },
        { pathLabel: "atomic", instructions: [makeIx()], labels: ["atomic"] },
      ])?.pathLabel
    ).toBe("atomic");
  });

  it("evaluateJitoTipMutation detects rpc unchanged and jito +1 expectation", () => {
    const expectedAdd = evaluateJitoTipMutation({
      baseInstructionCount: 5,
      rpcInstructionCount: 5,
      jitoInstructionCount: 6,
      tipLamports: 1000,
      tipAccountsCount: 8,
    });
    expect(expectedAdd.rpcUnchanged).toBe(true);
    expect(expectedAdd.jitoExpectedDeltaMatches).toBe(true);

    const expectedNoAdd = evaluateJitoTipMutation({
      baseInstructionCount: 5,
      rpcInstructionCount: 5,
      jitoInstructionCount: 5,
      tipLamports: 1000,
      tipAccountsCount: 0,
    });
    expect(expectedNoAdd.rpcUnchanged).toBe(true);
    expect(expectedNoAdd.jitoExpectedDeltaMatches).toBe(true);
  });
});
