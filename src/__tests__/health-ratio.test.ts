import { describe, it, expect } from "vitest";
import { computeHealthRatio } from "../math/health.js";
import { isLiquidatable } from "../math/liquidation.js";
import { PublicKey } from "@solana/web3.js";
import type { ReserveCache } from "../cache/reserveCache.js";
import type { OracleCache } from "../cache/oracleCache.js";
import type { ObligationDeposit, ObligationBorrow } from "../kamino/types.js";

describe("Health Ratio and Liquidation", () => {
  describe("computeHealthRatio", () => {
    it("should compute health ratio correctly for healthy position", () => {
      const reserves: ReserveCache = new Map([
        [
          "SOL",
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 1000000n,
            loanToValue: 80, // 80% LTV
            liquidationThreshold: 85,
            liquidationBonus: 500,
            oraclePubkeys: [PublicKey.unique()],
            liquidityDecimals: 9,
          },
        ],
        [
          "USDC",
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 1000000n,
            loanToValue: 90, // 90% LTV
            liquidationThreshold: 95,
            liquidationBonus: 500,
            oraclePubkeys: [PublicKey.unique()],
            liquidityDecimals: 6,
          },
        ],
      ]);

      const prices: OracleCache = new Map([
        [
          "SOL",
          {
            price: 10000000000n, // $100 with exponent -8
            confidence: 1000000n,
            slot: 1000000n,
            exponent: -8,
            oracleType: "pyth",
          },
        ],
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
          mint: "SOL",
          depositedAmount: "1000000000", // 1 SOL (9 decimals)
        },
      ];

      const borrows: ObligationBorrow[] = [
        {
          reserve: "reserve2",
          mint: "USDC",
          borrowedAmount: "50000000", // 50 USDC (6 decimals)
        },
      ];

      const result = computeHealthRatio({
        deposits,
        borrows,
        reserves,
        prices,
      });

      // Deposit: 1 SOL * $100 * 0.8 LTV = $80 weighted collateral
      // Borrow: 50 USDC * $1 = $50
      // Health ratio: $80 / $50 = 1.6
      expect(result.collateralValue).toBeCloseTo(80, 1);
      expect(result.borrowValue).toBeCloseTo(50, 1);
      expect(result.healthRatio).toBeCloseTo(1.6, 1);
    });

    it("should handle missing reserve gracefully", () => {
      const reserves: ReserveCache = new Map();
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

      // Should skip deposit with missing reserve
      expect(result.collateralValue).toBe(0);
      expect(result.borrowValue).toBe(0);
      expect(result.healthRatio).toBe(2); // Clamped to max (no borrows)
    });

    it("should handle missing price gracefully", () => {
      const reserves: ReserveCache = new Map([
        [
          "SOL",
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 1000000n,
            loanToValue: 80,
            liquidationThreshold: 85,
            liquidationBonus: 500,
            oraclePubkeys: [PublicKey.unique()],
            liquidityDecimals: 9,
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

      // Should skip deposit with missing price
      expect(result.collateralValue).toBe(0);
      expect(result.borrowValue).toBe(0);
      expect(result.healthRatio).toBe(2); // Clamped to max (no borrows)
    });

    it("should clamp health ratio to [0, 2]", () => {
      const reserves: ReserveCache = new Map([
        [
          "SOL",
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 1000000n,
            loanToValue: 90,
            liquidationThreshold: 95,
            liquidationBonus: 500,
            oraclePubkeys: [PublicKey.unique()],
            liquidityDecimals: 9,
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
          borrowedAmount: "100000000", // 0.1 SOL
        },
      ];

      const result = computeHealthRatio({
        deposits,
        borrows,
        reserves,
        prices,
      });

      // Very high health ratio should be clamped to 2
      expect(result.healthRatio).toBe(2);
    });

    it("should return 0 health ratio for underwater position", () => {
      const reserves: ReserveCache = new Map([
        [
          "SOL",
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 1000000n,
            loanToValue: 50, // Low LTV
            liquidationThreshold: 60,
            liquidationBonus: 500,
            oraclePubkeys: [PublicKey.unique()],
            liquidityDecimals: 9,
          },
        ],
        [
          "USDC",
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 1000000n,
            loanToValue: 90,
            liquidationThreshold: 95,
            liquidationBonus: 500,
            oraclePubkeys: [PublicKey.unique()],
            liquidityDecimals: 6,
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
          borrowedAmount: "100000000", // 100 USDC
        },
      ];

      const result = computeHealthRatio({
        deposits,
        borrows,
        reserves,
        prices,
      });

      // Deposit: 0.5 SOL * $100 * 0.5 LTV = $25 weighted collateral
      // Borrow: 100 USDC * $1 = $100
      // Health ratio: $25 / $100 = 0.25 (underwater)
      expect(result.collateralValue).toBeCloseTo(25, 1);
      expect(result.borrowValue).toBeCloseTo(100, 1);
      expect(result.healthRatio).toBeCloseTo(0.25, 1);
    });
  });

  describe("isLiquidatable", () => {
    it("should return true when health ratio is below threshold", () => {
      expect(isLiquidatable(0.8, 1.0)).toBe(true);
      expect(isLiquidatable(0.5, 0.85)).toBe(true);
      expect(isLiquidatable(0.0, 0.5)).toBe(true);
    });

    it("should return false when health ratio is at or above threshold", () => {
      expect(isLiquidatable(1.0, 1.0)).toBe(false);
      expect(isLiquidatable(1.5, 1.0)).toBe(false);
      expect(isLiquidatable(2.0, 1.0)).toBe(false);
    });

    it("should handle edge cases", () => {
      expect(isLiquidatable(0.9999, 1.0)).toBe(true);
      expect(isLiquidatable(1.0001, 1.0)).toBe(false);
    });
  });
});
