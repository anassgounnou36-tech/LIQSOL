import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Presubmitter } from "../presubmit/presubmitter.js";

vi.mock("../execute/planTxBuilder.js", () => ({
  buildPlanTransactions: vi.fn(),
}));

vi.mock("../execute/versionedTx.js", () => ({
  buildVersionedTx: vi.fn(),
}));

describe("presubmitter swap-required handling", () => {
  it("keeps setup-only fallback as partial when swap is required but not ready", async () => {
    const { buildPlanTransactions } = await import("../execute/planTxBuilder.js");
    vi.mocked(buildPlanTransactions).mockResolvedValue({
      setupIxs: [{}],
      setupLabels: ["setup:ata"],
      missingAtas: [],
      mainIxs: [{}],
      mainLabels: ["liquidate"],
      hasFarmsRefresh: false,
      hasPostFarmsRefresh: false,
      farmRequiredModes: [],
      swapIxs: [],
      swapLookupTables: [],
      atomicIxs: [{}, {}],
      atomicLabels: ["setup:ata", "liquidate"],
      atomicLookupTables: [],
      repayMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      collateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
      withdrawCollateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
      swapRequired: true,
      swapReady: false,
    } as any);

    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "bh" }),
    } as any;
    const presubmitter = new Presubmitter({
      connection,
      signer: Keypair.generate(),
      market: PublicKey.unique(),
      programId: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      topK: 1,
      refreshMs: 0,
      preReserveRefreshMode: "auto",
    });

    const entry = await presubmitter.getOrBuild({
      planVersion: 2,
      key: "obligation",
      obligationPubkey: PublicKey.unique().toBase58(),
      mint: "USDC",
      amountUsd: 10,
      repayMint: PublicKey.unique().toBase58(),
      collateralMint: PublicKey.unique().toBase58(),
      ev: 1,
      hazard: 0.1,
      ttlMin: 1,
      ttlComputedAtMs: Date.now(),
      ttlComputedMin: 1,
      createdAtMs: Date.now(),
    });

    expect(entry.mode).toBe("partial");
    expect(entry.tx).toBeUndefined();
    expect(entry.needsSetupFirst).toBe(true);
  });

  it("throws when swap is required/missing and setup-first fallback is not applicable", async () => {
    const { buildPlanTransactions } = await import("../execute/planTxBuilder.js");
    vi.mocked(buildPlanTransactions).mockResolvedValue({
      setupIxs: [],
      setupLabels: [],
      missingAtas: [],
      mainIxs: [{}],
      mainLabels: ["liquidate"],
      hasFarmsRefresh: false,
      hasPostFarmsRefresh: false,
      farmRequiredModes: [],
      swapIxs: [],
      swapLookupTables: [],
      atomicIxs: [{}],
      atomicLabels: ["liquidate"],
      atomicLookupTables: [],
      repayMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      collateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
      withdrawCollateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
      swapRequired: true,
      swapReady: false,
    } as any);

    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "bh" }),
    } as any;
    const presubmitter = new Presubmitter({
      connection,
      signer: Keypair.generate(),
      market: PublicKey.unique(),
      programId: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      topK: 1,
      refreshMs: 0,
      preReserveRefreshMode: "auto",
    });

    await expect(
      presubmitter.getOrBuild({
        planVersion: 2,
        key: "obligation",
        obligationPubkey: PublicKey.unique().toBase58(),
        mint: "USDC",
        amountUsd: 10,
        repayMint: PublicKey.unique().toBase58(),
        collateralMint: PublicKey.unique().toBase58(),
        ev: 1,
        hazard: 0.1,
        ttlMin: 1,
        ttlComputedAtMs: Date.now(),
        ttlComputedMin: 1,
        createdAtMs: Date.now(),
      })
    ).rejects.toThrow("swap-required-missing");
  });
});
