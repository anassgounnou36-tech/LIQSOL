import { describe, it, expect } from "vitest";
import { computeHealthRatio } from "../math/health.js";
import { explainHealth } from "../math/healthBreakdown.js";
import { selectCandidates } from "../strategy/candidateSelector.js";
import { PublicKey } from "@solana/web3.js";
import type { ReserveCacheEntry, ReserveCache } from "../cache/reserveCache.js";
import type { OracleCache } from "../cache/oracleCache.js";
import type { DecodedObligation } from "../kamino/types.js";

/**
 * Integration test to verify that validation and candidate metrics align
 * with PR7 health math (no independent collateral conversion).
 * 
 * This test simulates the flow:
 * 1. Scoring obligations via computeHealthRatio
 * 2. Selecting candidates via candidateSelector
 * 3. Validating via explainHealth
 * 
 * And verifies that all three produce consistent results.
 */
describe("PR8 Health Computation Alignment", () => {
  it("validation totals match scoring totals exactly", () => {
    // Set up reserve cache
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
          } as ReserveCacheEntry,
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
          } as ReserveCacheEntry,
        ],
      ]),
      byReserve: new Map(),
    };

    // Set up oracle cache
    const oracleCache: OracleCache = new Map([
      [
        "SOL",
        {
          price: 100000000000n, // $100 with exponent -9
          confidence: 1000000000n, // $1 confidence
          exponent: -9,
          slot: 1000n,
          oracleType: "pyth",
        },
      ],
      [
        "USDC",
        {
          price: 1000000000n, // $1 with exponent -9
          confidence: 10000000n, // $0.01 confidence
          exponent: -9,
          slot: 1000n,
          oracleType: "pyth",
        },
      ],
    ]);

    // Create test obligation
    const obligation: DecodedObligation = {
      obligationPubkey: "TEST_OBLIGATION",
      ownerPubkey: "TEST_OWNER",
      marketPubkey: "TEST_MARKET",
      lastUpdateSlot: "1000",
      deposits: [
        {
          reserve: "SOL_RESERVE",
          mint: "SOL",
          depositedAmount: "10000000000", // 10 SOL (9 decimals)
        },
      ],
      borrows: [
        {
          reserve: "USDC_RESERVE",
          mint: "USDC",
          borrowedAmount: "500000000000000000000000000", // 500 USDC in SF
        },
      ],
    };

    // 1. Score the obligation (simulates indexer scoring path)
    const scoringResult = computeHealthRatio({
      deposits: obligation.deposits,
      borrows: obligation.borrows,
      reserves: reserveCache.byMint,
      prices: oracleCache,
    });

    expect(scoringResult.scored).toBe(true);
    if (!scoringResult.scored) return;

    // 2. Create candidate from scoring result
    const candidates = selectCandidates([
      {
        obligationPubkey: obligation.obligationPubkey,
        ownerPubkey: obligation.ownerPubkey,
        healthRatio: scoringResult.healthRatio,
        liquidationEligible: scoringResult.healthRatio < 1.0,
        borrowValueUsd: scoringResult.borrowValue,
        collateralValueUsd: scoringResult.collateralValue,
      },
    ]);

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];

    // 3. Validate the candidate (simulates validation output)
    const validation = explainHealth(obligation, reserveCache, oracleCache);

    // 4. Verify all three sources produce identical totals
    
    // Scoring result vs validation totals (adjusted values)
    expect(validation.totals.collateralUsdAdj).toBeCloseTo(scoringResult.collateralValue, 6);
    expect(validation.totals.borrowUsdAdj).toBeCloseTo(scoringResult.borrowValue, 6);
    expect(validation.totals.healthRatio).toBeCloseTo(scoringResult.healthRatio, 6);
    
    // Candidate values vs validation totals (adjusted values)
    expect(validation.totals.collateralUsdAdj).toBeCloseTo(candidate.collateralValueUsd, 6);
    expect(validation.totals.borrowUsdAdj).toBeCloseTo(candidate.borrowValueUsd, 6);
    expect(validation.totals.healthRatio).toBeCloseTo(candidate.healthRatio, 6);
    
    // Candidate values vs scoring result (already verified to match via pass-through)
    expect(candidate.collateralValueUsd).toBeCloseTo(scoringResult.collateralValue, 6);
    expect(candidate.borrowValueUsd).toBeCloseTo(scoringResult.borrowValue, 6);
    expect(candidate.healthRatio).toBeCloseTo(scoringResult.healthRatio, 6);
  });

  it("deposit pricing uses underlying liquidity mint not collateral mint", () => {
    // Set up reserve cache
    const reserveCache: ReserveCache = {
      byMint: new Map([
        [
          "SOL_CTOKEN", // Collateral mint
          {
            reservePubkey: PublicKey.unique(),
            liquidityMint: "SOL", // Underlying liquidity mint (this should be used for pricing)
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
          } as ReserveCacheEntry,
        ],
      ]),
      byReserve: new Map(),
    };

    // Oracle price is ONLY for SOL (underlying), NOT for SOL_CTOKEN (collateral)
    const oracleCache: OracleCache = new Map([
      [
        "SOL", // Price is keyed by underlying liquidity mint
        {
          price: 100000000000n,
          confidence: 1000000000n,
          exponent: -9,
          slot: 1000n,
          oracleType: "pyth",
        },
      ],
      // NO price for "SOL_CTOKEN" - this would cause failure if collateral mint was used for pricing
    ]);

    const obligation: DecodedObligation = {
      obligationPubkey: "TEST_OBLIGATION",
      ownerPubkey: "TEST_OWNER",
      marketPubkey: "TEST_MARKET",
      lastUpdateSlot: "1000",
      deposits: [
        {
          reserve: "SOL_RESERVE",
          mint: "SOL_CTOKEN", // Deposit is in collateral token
          depositedAmount: "10000000000",
        },
      ],
      borrows: [],
    };

    // This should succeed because computeHealthRatio uses liquidityMint (SOL) for pricing
    const result = computeHealthRatio({
      deposits: obligation.deposits,
      borrows: obligation.borrows,
      reserves: reserveCache.byMint,
      prices: oracleCache,
      options: { includeBreakdown: true },
    });

    expect(result.scored).toBe(true);
    if (!result.scored) return;

    // Verify the breakdown shows correct mints
    expect(result.breakdown?.deposits).toHaveLength(1);
    const depositLeg = result.breakdown?.deposits[0];
    expect(depositLeg?.collateralMint).toBe("SOL_CTOKEN");
    expect(depositLeg?.liquidityMint).toBe("SOL"); // Underlying mint used for pricing
    expect(depositLeg?.priceUsd).toBeCloseTo(100, 1); // Base price from SOL oracle, not SOL_CTOKEN
  });

  it("validation breakdown shows realistic values not millions of SOL", () => {
    // Set up reserve cache with realistic exchange rate
    const reserveCache: ReserveCache = {
      byMint: new Map([
        [
          "SOL_CTOKEN",
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
            collateralExchangeRateUi: 1.02, // Realistic exchange rate
            scopePriceChain: null,
          } as ReserveCacheEntry,
        ],
      ]),
      byReserve: new Map(),
    };

    const oracleCache: OracleCache = new Map([
      [
        "SOL",
        {
          price: 100000000000n, // $100
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
          mint: "SOL_CTOKEN",
          depositedAmount: "10000000000", // 10 cToken
        },
      ],
      borrows: [],
    };

    const validation = explainHealth(obligation, reserveCache, oracleCache);

    // Check deposit leg shows realistic numbers
    expect(validation.deposits).toHaveLength(1);
    const depositLeg = validation.deposits[0];
    
    // Amount should be ~9.8 SOL (10 cToken / 1.02 exchange rate), not millions
    expect(depositLeg.amountUi).toBeGreaterThan(9);
    expect(depositLeg.amountUi).toBeLessThan(10);
    
    // USD value should be ~$970 (9.8 SOL * $99/SOL), not millions
    expect(depositLeg.usdValue).toBeGreaterThan(900);
    expect(depositLeg.usdValue).toBeLessThan(1000);
    
    // Verify no absurd values
    expect(depositLeg.amountUi).toBeLessThan(1000); // Not millions of SOL
    expect(depositLeg.usdValue).toBeLessThan(100000); // Not millions of USD
  });

  it("unclamped HR is exposed for debugging when health ratio is very high", () => {
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
          } as ReserveCacheEntry,
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
          } as ReserveCacheEntry,
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
      [
        "USDC",
        {
          price: 1000000000n,
          confidence: 10000000n,
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
          depositedAmount: "1000000000000", // 1000 SOL
        },
      ],
      borrows: [
        {
          reserve: "USDC_RESERVE",
          mint: "USDC",
          borrowedAmount: "10000000000000000000000000", // 10 USDC in SF
        },
      ],
    };

    // Get validation with unclamped HR
    const validation = explainHealth(obligation, reserveCache, oracleCache);

    // HR should be clamped to 2.0 for ranking
    expect(validation.totals.healthRatio).toBe(2.0);
    
    // But unclamped HR should be exposed for debugging
    expect(validation.totals.healthRatioRaw).toBeDefined();
    expect(validation.totals.healthRatioRaw).toBeGreaterThan(1000);
    
    // Approximations should note the clamping
    expect(validation.flags.approximations.length).toBeGreaterThan(0);
    expect(validation.flags.approximations.some(a => a.includes("clamped"))).toBe(true);
  });
});
