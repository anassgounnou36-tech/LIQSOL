import { describe, it, expect } from "vitest";
import { computeHealthRatio, type HealthRatioResult } from "../math/health.js";
import { explainHealth } from "../math/healthBreakdown.js";
import { PublicKey } from "@solana/web3.js";
import type { ReserveCacheEntry, ReserveCache } from "../cache/reserveCache.js";
import type { OracleCache } from "../cache/oracleCache.js";
import type { ObligationDeposit, ObligationBorrow, DecodedObligation } from "../kamino/types.js";

// Helper to extract scored result
type Scored = Extract<HealthRatioResult, { scored: true }>;

function expectScored(result: HealthRatioResult): Scored {
  expect(result.scored).toBe(true);
  return result as Scored;
}

describe("Health Breakdown with computeHealthRatio", () => {
  it("should return breakdown when includeBreakdown option is true", () => {
    const reserves: Map<string, ReserveCacheEntry> = new Map([
      [
        "SOL",
        {
          reservePubkey: PublicKey.unique(),
          liquidityMint: "SOL",
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
          collateralMint: "SOL_CTOKEN",
          collateralExchangeRateUi: 1.0,
          scopePriceChain: null,
        },
      ],
      [
        "USDC",
        {
          reservePubkey: PublicKey.unique(),
          liquidityMint: "USDC",
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
          collateralMint: "USDC_CTOKEN",
          collateralExchangeRateUi: 1.0,
          scopePriceChain: null,
        },
      ],
    ]);

    const prices: OracleCache = new Map([
      [
        "SOL",
        {
          price: 100000000000n, // $100 with exponent -9
          confidence: 1000000000n,
          exponent: -9,
          slot: 1000n,
          oracleType: "pyth",
        },
      ],
      [
        "USDC",
        {
          price: 1000000000n, // $1 with exponent -9
          confidence: 10000000n,
          exponent: -9,
          slot: 1000n,
          oracleType: "pyth",
        },
      ],
    ]);

    const deposits: ObligationDeposit[] = [
      {
        reserve: "SOL_RESERVE",
        mint: "SOL",
        depositedAmount: "10000000000", // 10 SOL (9 decimals)
      },
    ];

    const borrows: ObligationBorrow[] = [
      {
        reserve: "USDC_RESERVE",
        mint: "USDC",
        borrowedAmount: "500000000000000000000000000", // 500 USDC in SF (scaled fraction)
      },
    ];

    const result = computeHealthRatio({
      deposits,
      borrows,
      reserves,
      prices,
      options: { includeBreakdown: true, exposeRawHr: true },
    });

    const scored = expectScored(result);
    
    // Check that breakdown is included
    expect(scored.breakdown).toBeDefined();
    expect(scored.breakdown?.deposits).toHaveLength(1);
    expect(scored.breakdown?.borrows).toHaveLength(1);
    
    // Check deposit breakdown
    const depositLeg = scored.breakdown?.deposits[0];
    expect(depositLeg?.collateralMint).toBe("SOL");
    expect(depositLeg?.liquidityMint).toBe("SOL");
    expect(depositLeg?.collateralSharesUi).toBeCloseTo(10, 2);
    expect(depositLeg?.underlyingUi).toBeCloseTo(10, 2);
    expect(depositLeg?.priceUsd).toBeCloseTo(99, 1); // $100 - $1 confidence for collateral
    expect(depositLeg?.usdRaw).toBeCloseTo(990, 5);
    expect(depositLeg?.usdWeighted).toBeCloseTo(841.5, 5); // 990 * 0.85 liquidation threshold
    
    // Check borrow breakdown
    const borrowLeg = scored.breakdown?.borrows[0];
    expect(borrowLeg?.liquidityMint).toBe("USDC");
    expect(borrowLeg?.borrowUi).toBeCloseTo(500, 2);
    expect(borrowLeg?.priceUsd).toBeCloseTo(1.01, 0.01); // $1 + $0.01 confidence for borrow
    expect(borrowLeg?.usdRaw).toBeCloseTo(505, 5);
    expect(borrowLeg?.usdWeighted).toBeCloseTo(505, 5); // 505 * 1.0 borrow factor
    
    // Check totals
    expect(scored.totalCollateralUsd).toBeCloseTo(990, 5);
    expect(scored.totalCollateralUsdAdj).toBeCloseTo(841.5, 5);
    expect(scored.totalBorrowUsd).toBeCloseTo(505, 5);
    expect(scored.totalBorrowUsdAdj).toBeCloseTo(505, 5);
    
    // Check health ratio
    expect(scored.healthRatio).toBeCloseTo(1.67, 0.1); // 841.5 / 505
    expect(scored.healthRatioRaw).toBeCloseTo(1.67, 0.1);
  });

  it("should not return breakdown when includeBreakdown option is false", () => {
    const reserves: Map<string, ReserveCacheEntry> = new Map([
      [
        "SOL",
        {
          reservePubkey: PublicKey.unique(),
          liquidityMint: "SOL",
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
          collateralMint: "SOL_CTOKEN",
          collateralExchangeRateUi: 1.0,
          scopePriceChain: null,
        },
      ],
    ]);

    const prices: OracleCache = new Map([
      [
        "SOL",
        {
          price: 100000000000n,
          confidence: 1000000000n,
          exponent: -9,
          slot: 1000n,
          oracleType: "pyth",
        },
      ],
    ]);

    const deposits: ObligationDeposit[] = [
      {
        reserve: "SOL_RESERVE",
        mint: "SOL",
        depositedAmount: "10000000000",
      },
    ];

    const result = computeHealthRatio({
      deposits,
      borrows: [],
      reserves,
      prices,
      options: { includeBreakdown: false },
    });

    const scored = expectScored(result);
    expect(scored.breakdown).toBeUndefined();
  });

  it("explainHealth should use computeHealthRatio and return matching totals", () => {
    const reserveCache: ReserveCache = {
      byMint: new Map([
        [
          "SOL",
          {
            reservePubkey: PublicKey.unique(),
            liquidityMint: "SOL",
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
            collateralMint: "SOL_CTOKEN",
            collateralExchangeRateUi: 1.0,
            scopePriceChain: null,
          },
        ],
      ]),
      byReserve: new Map(),
    };

    const oracleCache: OracleCache = new Map([
      [
        "SOL",
        {
          price: 100000000000n,
          confidence: 1000000000n,
          exponent: -9,
          slot: 1000n,
          oracleType: "pyth",
        },
      ],
    ]);

    const obligation: DecodedObligation = {
      obligationPubkey: "TEST_OBLIGATION",
      ownerPubkey: "TEST_OWNER",
      marketPubkey: "TEST_MARKET",
      lastUpdateSlot: "1000",
      deposits: [
        {
          reserve: "SOL_RESERVE",
          mint: "SOL",
          depositedAmount: "10000000000",
        },
      ],
      borrows: [],
    };

    // Get breakdown from explainHealth
    const breakdown = explainHealth(obligation, reserveCache, oracleCache);

    // Get direct result from computeHealthRatio
    const directResult = computeHealthRatio({
      deposits: obligation.deposits,
      borrows: obligation.borrows,
      reserves: reserveCache.byMint,
      prices: oracleCache,
      options: { includeBreakdown: true, exposeRawHr: true },
    });

    const scored = expectScored(directResult);

    // Verify totals match
    expect(breakdown.totals.collateralUsdRaw).toBeCloseTo(scored.totalCollateralUsd, 1);
    expect(breakdown.totals.collateralUsdAdj).toBeCloseTo(scored.totalCollateralUsdAdj, 1);
    expect(breakdown.totals.borrowUsdRaw).toBeCloseTo(scored.totalBorrowUsd, 1);
    expect(breakdown.totals.borrowUsdAdj).toBeCloseTo(scored.totalBorrowUsdAdj, 1);
    expect(breakdown.totals.healthRatio).toBeCloseTo(scored.healthRatio, 4);
  });

  it("should expose unclamped health ratio when exposeRawHr is true", () => {
    const reserves: Map<string, ReserveCacheEntry> = new Map([
      [
        "SOL",
        {
          reservePubkey: PublicKey.unique(),
          liquidityMint: "SOL",
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
          collateralMint: "SOL_CTOKEN",
          collateralExchangeRateUi: 1.0,
          scopePriceChain: null,
        },
      ],
    ]);

    const prices: OracleCache = new Map([
      [
        "SOL",
        {
          price: 100000000000n,
          confidence: 1000000000n,
          exponent: -9,
          slot: 1000n,
          oracleType: "pyth",
        },
      ],
    ]);

    const deposits: ObligationDeposit[] = [
      {
        reserve: "SOL_RESERVE",
        mint: "SOL",
        depositedAmount: "100000000000", // 100 SOL
      },
    ];

    const borrows: ObligationBorrow[] = [
      {
        reserve: "USDC_RESERVE",
        mint: "USDC",
        borrowedAmount: "10000000000000000000000000", // 10 USDC in SF
      },
    ];

    // Add USDC reserve and price
    reserves.set("USDC", {
      reservePubkey: PublicKey.unique(),
      liquidityMint: "USDC",
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
      collateralMint: "USDC_CTOKEN",
      collateralExchangeRateUi: 1.0,
      scopePriceChain: null,
    });

    prices.set("USDC", {
      price: 1000000000n,
      confidence: 10000000n,
      exponent: -9,
      slot: 1000n,
      oracleType: "pyth",
    });

    const result = computeHealthRatio({
      deposits,
      borrows,
      reserves,
      prices,
      options: { exposeRawHr: true },
    });

    const scored = expectScored(result);
    
    // This should have a very high HR (100 SOL * $100 * 0.85 = $8500 vs $10 borrow)
    // Raw HR would be 850, but clamped to 2.0
    expect(scored.healthRatio).toBe(2.0);
    expect(scored.healthRatioRaw).toBeGreaterThan(100);
  });
});
