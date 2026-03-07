import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { buildPlanTransactions } from "../execute/planTxBuilder.js";

vi.mock("../kamino/canonicalLiquidationIxs.js", () => ({
  buildKaminoRefreshAndLiquidateIxsCanonical: vi
    .fn()
    .mockResolvedValueOnce({
      setupIxs: [],
      setupLabels: [],
      missingAtas: [],
      instructions: [{}],
      labels: ["liquidate"],
      repayMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      collateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
      withdrawCollateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
      hasFarmsRefresh: false,
      hasPostFarmsRefresh: false,
      farmRequiredModes: [],
    })
    .mockResolvedValueOnce({
      setupIxs: [],
      setupLabels: [],
      missingAtas: [],
      instructions: [{}],
      labels: ["liquidate"],
      repayMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      collateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
      withdrawCollateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
      hasFarmsRefresh: false,
      hasPostFarmsRefresh: false,
      farmRequiredModes: [],
    }),
}));

describe("planTxBuilder swap-required metadata", () => {
  it("marks cross-mint no-swap build as swapRequired=true and swapReady=false", async () => {
    const built = await buildPlanTransactions({
      connection: {} as any,
      signer: Keypair.generate(),
      market: PublicKey.unique(),
      programId: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      includeSwap: true,
      useRealSwapSizing: false,
      dry: false,
      plan: {
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
      },
    });

    expect(built.swapRequired).toBe(true);
    expect(built.swapReady).toBe(false);
  });
});
