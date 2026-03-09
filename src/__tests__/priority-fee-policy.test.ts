import { describe, expect, it, vi } from "vitest";
import { Keypair, TransactionInstruction } from "@solana/web3.js";
import {
  deriveWritableAccountsFromInstructions,
  quotePriorityFeeMicroLamports,
} from "../execute/priorityFeePolicy.js";

function makeIx(writableKeys: ReturnType<typeof Keypair.generate>["publicKey"][]): TransactionInstruction {
  return new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: writableKeys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    data: Buffer.alloc(0),
  });
}

describe("priority fee policy", () => {
  it("static mode returns static price", async () => {
    const connection = {
      getRecentPrioritizationFees: vi.fn(),
    } as any;
    const payer = Keypair.generate().publicKey;
    const quote = await quotePriorityFeeMicroLamports({
      connection,
      instructions: [],
      payer,
      staticMicroLamports: 12000,
      mode: "static",
      percentile: 75,
      floorMicroLamports: 10000,
      capMicroLamports: 250000,
      maxAccounts: 64,
    });
    expect(quote.recommendedMicroLamports).toBe(12000);
    expect(connection.getRecentPrioritizationFees).not.toHaveBeenCalled();
  });

  it("recent-fees mode uses non-zero samples when available", async () => {
    const connection = {
      getRecentPrioritizationFees: vi.fn().mockResolvedValue([
        { prioritizationFee: 0 },
        { prioritizationFee: 15000 },
        { prioritizationFee: 30000 },
      ]),
    } as any;
    const payer = Keypair.generate().publicKey;
    const quote = await quotePriorityFeeMicroLamports({
      connection,
      instructions: [],
      payer,
      staticMicroLamports: 10000,
      mode: "recent-fees",
      percentile: 75,
      floorMicroLamports: 5000,
      capMicroLamports: 250000,
      maxAccounts: 64,
    });
    expect(quote.mode).toBe("recent-fees");
    expect(quote.observedNonZeroSamples).toBe(2);
    expect(quote.recommendedMicroLamports).toBe(30000);
  });

  it("falls back to all samples when all zero", async () => {
    const connection = {
      getRecentPrioritizationFees: vi.fn().mockResolvedValue([
        { prioritizationFee: 0 },
        { prioritizationFee: 0 },
      ]),
    } as any;
    const payer = Keypair.generate().publicKey;
    const quote = await quotePriorityFeeMicroLamports({
      connection,
      instructions: [],
      payer,
      staticMicroLamports: 12000,
      mode: "recent-fees",
      percentile: 75,
      floorMicroLamports: 1000,
      capMicroLamports: 250000,
      maxAccounts: 64,
    });
    expect(quote.observedNonZeroSamples).toBe(0);
    expect(quote.recommendedMicroLamports).toBe(12000);
  });

  it("clamps to floor and cap", async () => {
    const payer = Keypair.generate().publicKey;
    const floorConnection = {
      getRecentPrioritizationFees: vi.fn().mockResolvedValue([{ prioritizationFee: 1000 }]),
    } as any;
    const floorQuote = await quotePriorityFeeMicroLamports({
      connection: floorConnection,
      instructions: [],
      payer,
      staticMicroLamports: 500,
      mode: "recent-fees",
      percentile: 50,
      floorMicroLamports: 10000,
      capMicroLamports: 250000,
      maxAccounts: 64,
    });
    expect(floorQuote.recommendedMicroLamports).toBe(10000);

    const capConnection = {
      getRecentPrioritizationFees: vi.fn().mockResolvedValue([{ prioritizationFee: 999999 }]),
    } as any;
    const capQuote = await quotePriorityFeeMicroLamports({
      connection: capConnection,
      instructions: [],
      payer,
      staticMicroLamports: 10000,
      mode: "recent-fees",
      percentile: 50,
      floorMicroLamports: 10000,
      capMicroLamports: 20000,
      maxAccounts: 64,
    });
    expect(capQuote.recommendedMicroLamports).toBe(20000);
  });

  it("writable account derivation dedupes and respects maxAccounts", () => {
    const payer = Keypair.generate().publicKey;
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const c = Keypair.generate().publicKey;
    const writable = deriveWritableAccountsFromInstructions({
      instructions: [makeIx([a, b, a]), makeIx([c, b])],
      payer,
      maxAccounts: 3,
    });
    expect(writable).toEqual([payer.toBase58(), a.toBase58(), b.toBase58()]);
  });
});
