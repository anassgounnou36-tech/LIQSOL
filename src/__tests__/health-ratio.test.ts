import { describe, it, expect } from "vitest";
import { computeHealthRatio, type HealthRatioResult } from "../math/health.js";
import { isLiquidatable } from "../math/liquidation.js";
import { PublicKey } from "@solana/web3.js";
import type { ReserveCacheEntry } from "../cache/reserveCache.js";
import type { OracleCache } from "../cache/oracleCache.js";
import type { ObligationDeposit, ObligationBorrow } from "../kamino/types.js";

// Helper type and function to work with discriminated union
type Scored = Extract<HealthRatioResult, { scored: true }>;

function expectScored(result: HealthRatioResult): Scored {
  expect(result.scored).toBe(true);
  return result as Scored;
}

describe("Health Ratio and Liquidation", () => {
  describe("computeHealthRatio", () => {
    it("should compute health ratio correctly for healthy position", () => {
      const reserves: Map<string, ReserveCacheEntry> = new Map([
        [
          "SOL",
          {
            reservePubkey: PublicKey.unique(),
            liquidityMint: "SOL", // Add liquidityMint field
            availableAmount: 1000000n,
            loanToValue: 80, // 80% LTV
            liquidationThreshold: 85, // 85% liquidation threshold
            liquidationBonus: 500,
            borrowFactor: 100, // 100% borrow factor
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
          "USDC",
          {
            reservePubkey: PublicKey.unique(),
            liquidityMint: "USDC", // Add liquidityMint field
            availableAmount: 1000000n,
            loanToValue: 90, // 90% LTV
            liquidationThreshold: 95, // 95% liquidation threshold
            liquidationBonus: 500,
            borrowFactor: 100, // 100% borrow factor
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

      const prices: OracleCache = new Map([
        [
          "SOL",
          {
            price: 10000000000n, // $100 with exponent -8
            confidence: 1000000n, // $0.01 confidence
            slot: 1000000n,
            exponent: -8,
            oracleType: "pyth",
          },
        ],
        [
          "USDC",
          {
            price: 100000000n, // $1 with exponent -8
            confidence: 10000n, // $0.0001 confidence
            slot: 1000000n,
            exponent: -8,
            oracleType: "pyth",
          },
        ],
      ]);

      const deposits: ObligationDeposit[] = [
        {
          reserve: "reserve1",
          mint: "SOL",
          depositedAmount: "1000000000", // 1 SOL (9 decimals)
        },
      ];

      const borrows: ObligationBorrow[] = [
        {
          reserve: "reserve2",
          mint: "USDC",
          borrowedAmount: "50000000000000000000000000", // 50 USDC (6 decimals), SF-scaled (50 * 10^6 * 10^18)
        },
      ];

      const result = computeHealthRatio({
        deposits,
        borrows,
        reserves,
        prices,
      });

      // Deposit: 1 SOL * $100 * 0.85 liquidationThreshold = $85 weighted collateral
      // Borrow: 50 USDC * $1 * 1.0 borrowFactor = $50 weighted borrow
      // Health ratio: $85 / $50 = 1.7
      const scored = expectScored(result);
      expect(scored.collateralValue).toBeCloseTo(85, 2);
      expect(scored.borrowValue).toBeCloseTo(50, 2);
      expect(scored.healthRatio).toBeCloseTo(1.7, 2);
    });

    it("should handle missing reserve gracefully", () => {
      const reserves: Map<string, ReserveCacheEntry> = new Map();
      const prices: OracleCache = new Map([
        [
          "SOL",
          {
            price: 10000000000n,
            confidence: 1000000n,
            slot: 1000000n,
            exponent: -8,
            oracleType: "pyth",
          },
        ],
      ]);

      const deposits: ObligationDeposit[] = [
        {
          reserve: "reserve1",
          mint: "SOL",
          depositedAmount: "1000000000",
        },
      ];

      const borrows: ObligationBorrow[] = [];

      const result = computeHealthRatio({
        deposits,
        borrows,
        reserves,
        prices,
      });

      // Should return unscored when reserve is missing
      expect(result.scored).toBe(false);
      if (!result.scored) {
        expect(result.reason).toBe("MISSING_RESERVE");
      }
    });

    it("should handle missing price gracefully", () => {
      const reserves: Map<string, ReserveCacheEntry> = new Map([
        [
          "SOL",
          {
            reservePubkey: PublicKey.unique(),
            liquidityMint: "SOL", // Add liquidityMint field
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
      ]);

      const prices: OracleCache = new Map();

      const deposits: ObligationDeposit[] = [
        {
          reserve: "reserve1",
          mint: "SOL",
          depositedAmount: "1000000000",
        },
      ];

      const borrows: ObligationBorrow[] = [];

      const result = computeHealthRatio({
        deposits,
        borrows,
        reserves,
        prices,
      });

      // Should return unscored when price is missing
      expect(result.scored).toBe(false);
      if (!result.scored) {
        expect(result.reason).toBe("MISSING_ORACLE_PRICE");
      }
    });

    it("should clamp health ratio to [0, 2]", () => {
      const reserves: Map<string, ReserveCacheEntry> = new Map([
        [
          "SOL",
          {
            reservePubkey: PublicKey.unique(),
            liquidityMint: "SOL", // Add liquidityMint field
            availableAmount: 1000000n,
            loanToValue: 90,
            liquidationThreshold: 95,
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
      ]);

      const prices: OracleCache = new Map([
        [
          "SOL",
          {
            price: 10000000000n,
            confidence: 1000000n,
            slot: 1000000n,
            exponent: -8,
            oracleType: "pyth",
          },
        ],
      ]);

      const deposits: ObligationDeposit[] = [
        {
          reserve: "reserve1",
          mint: "SOL",
          depositedAmount: "10000000000", // 10 SOL
        },
      ];

      const borrows: ObligationBorrow[] = [
        {
          reserve: "reserve1",
          mint: "SOL",
          borrowedAmount: "100000000000000000000000000", // 0.1 SOL (9 decimals), SF-scaled (0.1 * 10^9 * 10^18)
        },
      ];

      const result = computeHealthRatio({
        deposits,
        borrows,
        reserves,
        prices,
      });

      // Very high health ratio should be clamped to 2
      const scored = expectScored(result);
      expect(scored.healthRatio).toBe(2);
    });

    it("should return 0 health ratio for underwater position", () => {
      const reserves: Map<string, ReserveCacheEntry> = new Map([
        [
          "SOL",
          {
            reservePubkey: PublicKey.unique(),
            liquidityMint: "SOL", // Add liquidityMint field
            availableAmount: 1000000n,
            loanToValue: 50, // Low LTV
            liquidationThreshold: 60, // Low liquidation threshold
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
          "USDC",
          {
            reservePubkey: PublicKey.unique(),
            liquidityMint: "USDC", // Add liquidityMint field
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

      const prices: OracleCache = new Map([
        [
          "SOL",
          {
            price: 10000000000n, // $100
            confidence: 1000000n,
            slot: 1000000n,
            exponent: -8,
            oracleType: "pyth",
          },
        ],
        [
          "USDC",
          {
            price: 100000000n, // $1
            confidence: 10000n,
            slot: 1000000n,
            exponent: -8,
            oracleType: "pyth",
          },
        ],
      ]);

      const deposits: ObligationDeposit[] = [
        {
          reserve: "reserve1",
          mint: "SOL",
          depositedAmount: "500000000", // 0.5 SOL
        },
      ];

      const borrows: ObligationBorrow[] = [
        {
          reserve: "reserve2",
          mint: "USDC",
          borrowedAmount: "100000000000000000000000000", // 100 USDC (6 decimals), SF-scaled (100 * 10^6 * 10^18)
        },
      ];

      const result = computeHealthRatio({
        deposits,
        borrows,
        reserves,
        prices,
      });

      // Deposit: 0.5 SOL * $100 * 0.6 liquidationThreshold = $30 weighted collateral
      // Borrow: 100 USDC * $1 * 1.0 borrowFactor = $100 weighted borrow
      // Health ratio: $30 / $100 = 0.30 (underwater)
      const scored = expectScored(result);
      expect(scored.collateralValue).toBeCloseTo(30, 1);
      expect(scored.borrowValue).toBeCloseTo(100, 1);
      expect(scored.healthRatio).toBeCloseTo(0.30, 1);
    });

    it("should correctly convert deposits using inverted exchange rate formula", () => {
      // Test the corrected deposit conversion: depositUi = depositedNotesUi / exchangeRateUi
      // Scenario: Exchange rate > 1 (collateral tokens worth more than liquidity tokens due to accrued interest)
      const reserves: Map<string, ReserveCacheEntry> = new Map([
        [
          "USDC",
          {
            reservePubkey: PublicKey.unique(),
            liquidityMint: "USDC", // Add liquidityMint field
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
            // Exchange rate = 1.1 means 1.1 collateral tokens = 1 liquidity token
            // So 100 collateral tokens = 100 / 1.1 = ~90.91 liquidity tokens
            collateralExchangeRateUi: 1.1,
            scopePriceChain: null,
          },
        ],
      ]);

      const prices: OracleCache = new Map([
        [
          "USDC",
          {
            price: 100000000n, // $1 with exponent -8
            confidence: 10000n,
            slot: 1000000n,
            exponent: -8,
            oracleType: "pyth",
          },
        ],
      ]);

      const deposits: ObligationDeposit[] = [
        {
          reserve: "reserve1",
          mint: "USDC",
          depositedAmount: "100000000", // 100 collateral tokens (6 decimals)
        },
      ];

      const borrows: ObligationBorrow[] = [];

      const result = computeHealthRatio({
        deposits,
        borrows,
        reserves,
        prices,
      });

      // With corrected formula: depositUi = 100 / 1.1 = 90.909... liquidity tokens
      // collateralValue = 90.909 * $1 * 0.95 (liquidation threshold) = $86.36
      const scored = expectScored(result);
      expect(scored.collateralValue).toBeCloseTo(86.36, 1);
      expect(scored.borrowValue).toBe(0);
      expect(scored.healthRatio).toBe(2.0); // No debt = max health
    });

    it("should convert borrowedAmountSf to UI with cumulativeBorrowRateBsfRaw applied", () => {
      const WAD = 1000000000000000000n; // 1e18
      const rate13025 = (WAD * 13025n) / 10000n; // 1.3025 × 1e18

      const makeReserves = (rate: bigint): Map<string, ReserveCacheEntry> =>
        new Map([
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
              cumulativeBorrowRate: 0n,
              cumulativeBorrowRateBsfRaw: rate,
              collateralMint: "mock-collateral-mint",
              collateralExchangeRateUi: 1.0,
              scopePriceChain: null,
            },
          ],
        ]);

      const prices: OracleCache = new Map([
        [
          "USDC",
          {
            price: 100000000n, // $1 with exponent -8
            confidence: 0n,
            slot: 1000000n,
            exponent: -8,
            oracleType: "pyth",
          },
        ],
      ]);

      // 100 USDC borrow in SF units (100 * 10^6 * 10^18)
      const borrows: ObligationBorrow[] = [
        {
          reserve: "reserve1",
          mint: "USDC",
          borrowedAmount: "100000000000000000000000000",
        },
      ];

      // borrowedAmountSf conversion applies cumulativeBorrowRateBsfRaw.
      const resultBase = computeHealthRatio({
        deposits: [],
        borrows,
        reserves: makeReserves(WAD),
        prices,
      });

      const resultWithHigherRate = computeHealthRatio({
        deposits: [],
        borrows,
        reserves: makeReserves(rate13025),
        prices,
      });

      const base = expectScored(resultBase);
      const withHigherRate = expectScored(resultWithHigherRate);

      expect(base.totalBorrowUsd).toBeCloseTo(100, 6);
      expect(withHigherRate.totalBorrowUsd).toBeCloseTo(130.25, 6);
      expect(withHigherRate.borrowValue).toBeCloseTo(130.25, 6);
    });
  });

  describe("isLiquidatable", () => {
    it("should return true when health ratio is below 1.0", () => {
      expect(isLiquidatable(0.8)).toBe(true);
      expect(isLiquidatable(0.5)).toBe(true);
      expect(isLiquidatable(0.0)).toBe(true);
      expect(isLiquidatable(0.9999)).toBe(true);
    });

    it("should return false when health ratio is at or above 1.0", () => {
      expect(isLiquidatable(1.0)).toBe(false);
      expect(isLiquidatable(1.5)).toBe(false);
      expect(isLiquidatable(2.0)).toBe(false);
      expect(isLiquidatable(1.0001)).toBe(false);
    });

    it("should return false when health ratio is null (unscored)", () => {
      expect(isLiquidatable(null)).toBe(false);
    });
  });
});
