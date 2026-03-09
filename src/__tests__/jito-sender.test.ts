import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { fetchJitoTipAccounts, sendTransactionViaJito } from "../execute/jitoSender.js";
import { sendWithRebuildRetry } from "../execute/broadcastRetry.js";
import { withOptionalJitoTipInstruction } from "../execute/executor.js";

describe("jito sender", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.JITO_TIP_ACCOUNT_CACHE_MS = "0";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("tip account fetch parses JSON-RPC response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: ["11111111111111111111111111111111"] }),
    } as any);

    const accounts = await fetchJitoTipAccounts({ bundlesUrl: "https://example.com/bundles" });
    expect(accounts).toEqual(["11111111111111111111111111111111"]);
  });

  it("tip accounts are cached", async () => {
    process.env.JITO_TIP_ACCOUNT_CACHE_MS = "300000";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: ["11111111111111111111111111111111"] }),
    } as any);
    globalThis.fetch = fetchMock;

    await fetchJitoTipAccounts({ bundlesUrl: "https://example.com/bundles" });
    await fetchJitoTipAccounts({ bundlesUrl: "https://example.com/bundles" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Jito sender parses signature result", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "bundle-123" },
      json: async () => ({ result: "sig-abc" }),
    } as any);

    const tx = {
      serialize: () => Buffer.from("abc"),
    } as any;
    const result = await sendTransactionViaJito({
      tx,
      txUrl: "https://example.com/tx",
      bundleOnly: true,
    });
    expect(result).toEqual({ signature: "sig-abc", bundleId: "bundle-123" });
  });

  it("transport abstraction uses Jito transport when configured", async () => {
    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "bh" }),
      sendTransaction: vi.fn(),
      getSignatureStatuses: vi.fn().mockResolvedValue({
        value: [{ confirmationStatus: "confirmed", err: null, slot: 1 }],
      }),
    } as any;

    const signer = Keypair.generate();
    const tx = { sign: vi.fn() } as any;
    const transport = {
      sendSignedTransaction: vi.fn().mockResolvedValue({ signature: "jito-sig", bundleId: "bundle-1" }),
    };

    const attempts = await sendWithRebuildRetry(
      connection,
      signer,
      async () => tx,
      { maxAttempts: 1, cuLimit: 1000, cuPrice: 1000 },
      transport
    );

    expect(transport.sendSignedTransaction).toHaveBeenCalledTimes(1);
    expect(connection.sendTransaction).not.toHaveBeenCalled();
    expect(attempts[0]?.signature).toBe("jito-sig");
  });

  it("final broadcast rebuild adds tip instruction only in Jito mode", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: ["11111111111111111111111111111111"] }),
    } as any);

    const baseIxs: TransactionInstruction[] = [
      new TransactionInstruction({
        programId: SystemProgram.programId,
        keys: [],
        data: Buffer.alloc(0),
      }),
    ];
    const signer = Keypair.generate().publicKey;

    const rpcIxs = await withOptionalJitoTipInstruction({
      instructions: baseIxs,
      broadcast: true,
      sendMode: "rpc",
      signer,
      tipLamports: 1000,
      bundlesUrl: "https://example.com/bundles",
    });
    const jitoIxs = await withOptionalJitoTipInstruction({
      instructions: baseIxs,
      broadcast: true,
      sendMode: "jito",
      signer,
      tipLamports: 1000,
      bundlesUrl: "https://example.com/bundles",
    });

    expect(rpcIxs).toHaveLength(1);
    expect(jitoIxs).toHaveLength(2);
    expect(jitoIxs[1]?.programId.toBase58()).toBe(SystemProgram.programId.toBase58());
    const tipTo = jitoIxs[1]?.keys[1]?.pubkey?.toBase58();
    expect(tipTo).toBe(new PublicKey("11111111111111111111111111111111").toBase58());
  });
});
