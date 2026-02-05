import { describe, it, expect, beforeEach } from "vitest";
import { LiveObligationIndexer } from "../engine/liveObligationIndexer.js";
import { PublicKey } from "@solana/web3.js";
import type { ReserveCache } from "../cache/reserveCache.js";
import type { OracleCache } from "../cache/oracleCache.js";

/**
 * Tests for PR7 gate: Reserve membership precheck
 * 
 * These tests verify that obligations are properly filtered based on whether they
 * reference loaded reserves, BEFORE market and allowlist filtering.
 */
describe("Reserve Membership Precheck (PR7 Gate)", () => {
  let indexer: LiveObligationIndexer;
  let reserveCache: ReserveCache;
  let oracleCache: OracleCache;

  // Mock reserve pubkeys (use unique() to generate valid base58 pubkeys)
  let solReservePubkey: string;
  let usdcReservePubkey: string;
  let otherReservePubkey: string;

  beforeEach(() => {
    // Generate unique pubkeys for each test run
    solReservePubkey = PublicKey.unique().toString();
    usdcReservePubkey = PublicKey.unique().toString();
    otherReservePubkey = PublicKey.unique().toString();

    // Set up a reserve cache with only SOL and USDC (simulating SOL+USDC mode)
    reserveCache = new Map([
      [
        solReservePubkey,
        {
          reservePubkey: new PublicKey(solReservePubkey),
          liquidityMint: "So11111111111111111111111111111111111111112",
          availableAmount: 1000000n,
          loanToValue: 80,
          liquidationThreshold: 85,
          liquidationBonus: 500,
          borrowFactor: 100,
          oraclePubkeys: [PublicKey.unique()],
          liquidityDecimals: 9,
          collateralDecimals: 9,
          cumulativeBorrowRate: 10000000000n,
          cumulativeBorrowRateBsfRaw: 1000000000000000000n,
          collateralMint: "mock-collateral-mint",
          collateralExchangeRateUi: 1.0,
          scopePriceChain: null,
        },
      ],
      [
        usdcReservePubkey,
        {
          reservePubkey: new PublicKey(usdcReservePubkey),
          liquidityMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          availableAmount: 1000000n,
          loanToValue: 90,
          liquidationThreshold: 95,
          liquidationBonus: 500,
          borrowFactor: 100,
          oraclePubkeys: [PublicKey.unique()],
          liquidityDecimals: 6,
          collateralDecimals: 6,
          cumulativeBorrowRate: 10000000000n,
          cumulativeBorrowRateBsfRaw: 1000000000000000000n,
          collateralMint: "mock-collateral-mint",
          collateralExchangeRateUi: 1.0,
          scopePriceChain: null,
        },
      ],
    ]);

    // Set up a minimal oracle cache
    oracleCache = new Map([
      [
        "So11111111111111111111111111111111111111112",
        {
          price: 10000000000n,
          confidence: 1000000n,
          slot: 1000000n,
          exponent: -8,
          oracleType: "pyth",
        },
      ],
      [
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        {
          price: 100000000n,
          confidence: 10000n,
          slot: 1000000n,
          exponent: -8,
          oracleType: "pyth",
        },
      ],
    ]);

    // Create indexer with SOL+USDC allowlist
    indexer = new LiveObligationIndexer({
      yellowstoneUrl: "http://localhost:10000",
      yellowstoneToken: "test-token",
      programId: PublicKey.unique(),
      rpcUrl: "http://localhost:8899",
      reserveCache,
      oracleCache,
      allowedLiquidityMints: new Set([
        "So11111111111111111111111111111111111111112",
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      ]),
    });
  });

  it("should accept obligations that touch known reserves (SOL deposit)", () => {
    // Create a mock obligation with SOL deposit
    const obligation = {
      obligationPubkey: PublicKey.unique().toString(),
      ownerPubkey: PublicKey.unique().toString(),
      marketPubkey: PublicKey.unique().toString(),
      deposits: [
        {
          reserve: solReservePubkey,
          mint: "So11111111111111111111111111111111111111112",
          depositedAmount: "1000000000",
        },
      ],
      borrows: [],
    };

    // Use internal computeHealthScoring method via reflection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (indexer as any).computeHealthScoring(obligation);

    // Should NOT be filtered as OTHER_MARKET
    expect(result.unscoredReason).not.toBe("OTHER_MARKET");

    // Verify touchesKnownReserveCount was incremented
    const stats = indexer.getStats();
    expect(stats.touchesKnownReserveCount).toBe(1);
  });

  it("should accept obligations that touch known reserves (USDC borrow)", () => {
    // Create a mock obligation with USDC borrow
    const obligation = {
      obligationPubkey: PublicKey.unique().toString(),
      ownerPubkey: PublicKey.unique().toString(),
      marketPubkey: PublicKey.unique().toString(),
      deposits: [],
      borrows: [
        {
          reserve: usdcReservePubkey,
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          borrowedAmount: "50000000000000000000000000",
        },
      ],
    };

    // Use internal computeHealthScoring method via reflection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (indexer as any).computeHealthScoring(obligation);

    // Should NOT be filtered as OTHER_MARKET (but may be EMPTY_OBLIGATION or need both deposits)
    // In this case, the obligation has only borrows, so it won't be empty
    expect(result.unscoredReason).not.toBe("OTHER_MARKET");

    // Verify touchesKnownReserveCount was incremented
    const stats = indexer.getStats();
    expect(stats.touchesKnownReserveCount).toBe(1);
  });

  it("should reject obligations that do NOT touch any known reserves", () => {
    // Create a mock obligation with unknown reserve
    const obligation = {
      obligationPubkey: PublicKey.unique().toString(),
      ownerPubkey: PublicKey.unique().toString(),
      marketPubkey: PublicKey.unique().toString(),
      deposits: [
        {
          reserve: otherReservePubkey,
          mint: "SomEOtHeRMiNt11111111111111111111111111111",
          depositedAmount: "1000000000",
        },
      ],
      borrows: [],
    };

    // Use internal computeHealthScoring method via reflection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (indexer as any).computeHealthScoring(obligation);

    // Should be filtered as OTHER_MARKET
    expect(result.unscoredReason).toBe("OTHER_MARKET");

    // Verify touchesKnownReserveCount was NOT incremented
    const stats = indexer.getStats();
    expect(stats.touchesKnownReserveCount).toBe(0);

    // Verify skippedOtherMarketsCount was incremented
    expect(stats.skippedOtherMarketsCount).toBe(1);
  });

  it("should accept obligations with mixed reserves if ANY reserve is known", () => {
    // Create a mock obligation with one known and one unknown reserve
    const obligation = {
      obligationPubkey: PublicKey.unique().toString(),
      ownerPubkey: PublicKey.unique().toString(),
      marketPubkey: PublicKey.unique().toString(),
      deposits: [
        {
          reserve: solReservePubkey, // Known
          mint: "So11111111111111111111111111111111111111112",
          depositedAmount: "1000000000",
        },
        {
          reserve: otherReservePubkey, // Unknown
          mint: "SomEOtHeRMiNt11111111111111111111111111111",
          depositedAmount: "1000000",
        },
      ],
      borrows: [],
    };

    // Use internal computeHealthScoring method via reflection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (indexer as any).computeHealthScoring(obligation);

    // Should NOT be filtered as OTHER_MARKET because it touches at least one known reserve
    expect(result.unscoredReason).not.toBe("OTHER_MARKET");

    // Verify touchesKnownReserveCount was incremented
    const stats = indexer.getStats();
    expect(stats.touchesKnownReserveCount).toBe(1);
  });

  it("should run reserve membership check BEFORE marketPubkey check", () => {
    // Create an indexer with a specific marketPubkey filter
    const marketPubkey = PublicKey.unique();
    const indexerWithMarket = new LiveObligationIndexer({
      yellowstoneUrl: "http://localhost:10000",
      yellowstoneToken: "test-token",
      programId: PublicKey.unique(),
      marketPubkey, // Set market filter
      rpcUrl: "http://localhost:8899",
      reserveCache,
      oracleCache,
      allowedLiquidityMints: new Set([
        "So11111111111111111111111111111111111111112",
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      ]),
    });

    // Create an obligation with:
    // 1. Unknown reserve (should fail reserve membership check)
    // 2. Wrong market (should fail market check if it gets there)
    const obligation = {
      obligationPubkey: PublicKey.unique().toString(),
      ownerPubkey: PublicKey.unique().toString(),
      marketPubkey: PublicKey.unique().toString(), // Wrong market (different from marketPubkey above)
      deposits: [
        {
          reserve: otherReservePubkey, // Unknown reserve
          mint: "SomEOtHeRMiNt11111111111111111111111111111",
          depositedAmount: "1000000000",
        },
      ],
      borrows: [],
    };

    // Use internal computeHealthScoring method via reflection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (indexerWithMarket as any).computeHealthScoring(obligation);

    // Should be filtered as OTHER_MARKET due to reserve membership check
    // (not due to marketPubkey check, which would also fail but comes later)
    expect(result.unscoredReason).toBe("OTHER_MARKET");

    // Verify stats show it was filtered by reserve membership, not market
    const stats = indexerWithMarket.getStats();
    expect(stats.touchesKnownReserveCount).toBe(0);
    expect(stats.skippedOtherMarketsCount).toBe(1);
  });

  it("should run reserve membership check when reserveCache is present", () => {
    // This test verifies the check only runs when reserveCache is available
    const indexerNoCache = new LiveObligationIndexer({
      yellowstoneUrl: "http://localhost:10000",
      yellowstoneToken: "test-token",
      programId: PublicKey.unique(),
      rpcUrl: "http://localhost:8899",
      // No reserveCache provided
    });

    // Create an obligation with unknown reserve
    const obligation = {
      obligationPubkey: PublicKey.unique().toString(),
      ownerPubkey: PublicKey.unique().toString(),
      marketPubkey: PublicKey.unique().toString(),
      deposits: [
        {
          reserve: otherReservePubkey,
          mint: "SomEOtHeRMiNt11111111111111111111111111111",
          depositedAmount: "1000000000",
        },
      ],
      borrows: [],
    };

    // Use internal computeHealthScoring method via reflection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (indexerNoCache as any).computeHealthScoring(obligation);

    // Should NOT be filtered as OTHER_MARKET because reserveCache is not available
    // (The precheck is skipped when reserveCache is undefined)
    // It should fail later with NO_CACHES or similar
    expect(result.unscoredReason).not.toBe("OTHER_MARKET");
    expect(result.unscoredReason).toBe("NO_CACHES");

    // Verify touchesKnownReserveCount was NOT incremented
    const stats = indexerNoCache.getStats();
    expect(stats.touchesKnownReserveCount).toBe(0);
  });
});
