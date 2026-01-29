import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { LiveObligationIndexer } from "../engine/liveObligationIndexer.js";
import { Buffer } from "buffer";

// Mock data
const VALID_OBLIGATION_DATA = Buffer.from("01".repeat(500), "hex");

// Mock modules
vi.mock("../yellowstone/client.js", () => ({
  createYellowstoneClient: vi.fn().mockResolvedValue({}),
}));

vi.mock("../yellowstone/subscribeAccounts.js", () => {
  return {
    subscribeToAccounts: vi.fn().mockImplementation(() => {
      let resolveDone: () => void;
      
      const donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      
      const mockHandle = {
        close: vi.fn(() => {
          resolveDone();
        }),
        done: donePromise,
      };
      
      return Promise.resolve(mockHandle);
    }),
  };
});

vi.mock("../kamino/decoder.js", () => ({
  decodeObligation: vi.fn().mockReturnValue({
    pubkey: "test",
    deposits: [],
    borrows: [],
    depositedValue: "0",
    borrowedValue: "0",
    unhealthyBorrowValue: "0",
    superUnhealthyBorrowValue: "0",
    depositsAssetTiers: [],
    borrowsAssetTiers: [],
    marketId: "test",
    marketName: "test",
    elevationGroup: 0,
    highestBorrowFactor: 0,
    loanToValue: 0,
    owner: new PublicKey("11111111111111111111111111111112"),
  }),
}));

// Mock Connection
vi.mock("@solana/web3.js", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = await vi.importActual("@solana/web3.js") as any;
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getMultipleAccountsInfo: vi.fn().mockResolvedValue([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { data: VALID_OBLIGATION_DATA, owner: new (actual as any).PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD") },
      ]),
    })),
  };
});

describe("LiveObligationIndexer - Auto-Inject Discriminator", () => {
  const testDataDir = join(process.cwd(), "test-data-auto-inject");
  const testFilePath = join(testDataDir, "obligations.jsonl");
  const testProgramId = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
  const testRpcUrl = "https://api.mainnet-beta.solana.com";

  beforeEach(() => {
    mkdirSync(testDataDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should auto-inject obligation discriminator filter when filters is undefined", async () => {
    writeFileSync(testFilePath, "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo\n", "utf-8");

    const indexer = new LiveObligationIndexer({
      yellowstoneUrl: "https://test.example.com",
      yellowstoneToken: "test-token",
      programId: testProgramId,
      rpcUrl: testRpcUrl,
      obligationsFilePath: testFilePath,
      filters: undefined, // Explicitly undefined
    });

    await indexer.start();
    
    // Give it time to start subscription
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Import to check if subscribeToAccounts was called with filters
    const { subscribeToAccounts } = await import("../yellowstone/subscribeAccounts.js");
    
    // Check that subscribeToAccounts was called
    expect(subscribeToAccounts).toHaveBeenCalled();
    
    // Get the call arguments
    const callArgs = vi.mocked(subscribeToAccounts).mock.calls[0];
    const filters = callArgs[2]; // Third argument is filters
    
    // Verify filter was injected
    expect(filters).toBeDefined();
    expect(filters.length).toBe(1);
    expect(filters[0]).toHaveProperty("memcmp");
    expect(filters[0]?.memcmp).toBeDefined();
    expect(filters[0]!.memcmp!.offset).toBe("0"); // offset should be string
    expect(filters[0]!.memcmp).toHaveProperty("base64");
    
    await indexer.stop();
  });

  it("should auto-inject obligation discriminator filter when filters is empty array", async () => {
    writeFileSync(testFilePath, "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo\n", "utf-8");

    const indexer = new LiveObligationIndexer({
      yellowstoneUrl: "https://test.example.com",
      yellowstoneToken: "test-token",
      programId: testProgramId,
      rpcUrl: testRpcUrl,
      obligationsFilePath: testFilePath,
      filters: [], // Explicitly empty
    });

    await indexer.start();
    
    // Give it time to start subscription
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Import to check if subscribeToAccounts was called with filters
    const { subscribeToAccounts } = await import("../yellowstone/subscribeAccounts.js");
    
    // Check that subscribeToAccounts was called
    expect(subscribeToAccounts).toHaveBeenCalled();
    
    // Get the call arguments
    const callArgs = vi.mocked(subscribeToAccounts).mock.calls[0];
    const filters = callArgs[2]; // Third argument is filters
    
    // Verify filter was injected
    expect(filters).toBeDefined();
    expect(filters.length).toBe(1);
    expect(filters[0]).toHaveProperty("memcmp");
    expect(filters[0]?.memcmp).toBeDefined();
    expect(filters[0]!.memcmp!.offset).toBe("0"); // offset should be string
    expect(filters[0]!.memcmp).toHaveProperty("base64");
    
    await indexer.stop();
  });

  it("should NOT auto-inject when filters are provided", async () => {
    writeFileSync(testFilePath, "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo\n", "utf-8");

    const customFilter = {
      memcmp: {
        offset: "10", // String offset for gRPC type compatibility
        base64: "dGVzdA==", // "test" in base64
      },
    };

    const indexer = new LiveObligationIndexer({
      yellowstoneUrl: "https://test.example.com",
      yellowstoneToken: "test-token",
      programId: testProgramId,
      rpcUrl: testRpcUrl,
      obligationsFilePath: testFilePath,
      filters: [customFilter],
    });

    await indexer.start();
    
    // Give it time to start subscription
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Import to check if subscribeToAccounts was called with filters
    const { subscribeToAccounts } = await import("../yellowstone/subscribeAccounts.js");
    
    // Get the call arguments
    const callArgs = vi.mocked(subscribeToAccounts).mock.calls[0];
    const filters = callArgs[2]; // Third argument is filters
    
    // Verify custom filter is still used (not replaced)
    expect(filters).toBeDefined();
    expect(filters.length).toBe(1);
    expect(filters[0]?.memcmp).toBeDefined();
    expect(filters[0]!.memcmp!.offset).toBe("10");
    expect(filters[0]!.memcmp!.base64).toBe("dGVzdA==");
    
    await indexer.stop();
  });

  it("should inject filter with correct discriminator bytes", async () => {
    writeFileSync(testFilePath, "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo\n", "utf-8");

    const indexer = new LiveObligationIndexer({
      yellowstoneUrl: "https://test.example.com",
      yellowstoneToken: "test-token",
      programId: testProgramId,
      rpcUrl: testRpcUrl,
      obligationsFilePath: testFilePath,
    });

    await indexer.start();
    
    // Give it time to start subscription
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Import discriminator function to calculate expected value
    const { anchorDiscriminator } = await import("../kamino/decode/discriminator.js");
    const expectedDiscriminator = anchorDiscriminator("Obligation");
    const expectedBase64 = expectedDiscriminator.toString("base64");
    
    // Import to check if subscribeToAccounts was called with filters
    const { subscribeToAccounts } = await import("../yellowstone/subscribeAccounts.js");
    
    // Get the call arguments
    const callArgs = vi.mocked(subscribeToAccounts).mock.calls[0];
    const filters = callArgs[2]; // Third argument is filters
    
    // Verify discriminator matches expected value
    expect(filters[0]?.memcmp).toBeDefined();
    expect(filters[0]!.memcmp!.base64).toBe(expectedBase64);
    
    await indexer.stop();
  });
});
