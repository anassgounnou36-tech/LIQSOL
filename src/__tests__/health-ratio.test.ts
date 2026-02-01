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
            liquidationThreshold: 85, // 85% liquidation threshold
            liquidationBonus: 500,
            borrowFactor: 100, // 100% borrow factor
            oraclePubkeys: [PublicKey.unique()],
            liquidityDecimals: 9,
            collateralDecimals: 9,
            cumulativeBorrowRate: 10000000000n,
            scopePriceChain: null,
          },
        ],
        [
          "USDC",
          {
            reservePubkey: PublicKey.unique(),
            availableAmount: 1000000n,
            loanToValue: 90, // 90% LTV
            liquidationThreshold: 95, // 95% liquidation threshold
            liquidationBonus: 500,
            borrowFactor: 100, // 100% borrow factor
            oraclePubkeys: [PublicKey.unique()],
            liquidityDecimals: 6,
            collateralDecimals: 6,
            cumulativeBorrowRate: 10000000000n,
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
          borrowedAmount: "500000000000000000", // 50 USDC (6 decimals)
        },
      ];

      const result = computeHealthRatio({
        deposits,
        borrows,
        reserves,
        prices,
      });

      // Deposit: 1 SOL * ($100 - $0.01 confidence) * 0.85 liquidationThreshold = $84.9915 weighted collateral
      // Borrow: 50 USDC * ($1 + $0.0001 confidence) * 1.0 borrowFactor = $50.005 weighted borrow
      // Health ratio: $84.9915 / $50.005 ≈ 1.699
      expect(result.collateralValue).toBeCloseTo(84.9915, 2);
      expect(result.borrowValue).toBeCloseTo(50.005, 2);
      expect(result.healthRatio).toBeCloseTo(1.699, 2);
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
            borrowFactor: 100,
            oraclePubkeys: [PublicKey.unique()],
            liquidityDecimals: 9,
            collateralDecimals: 9,
            cumulativeBorrowRate: 10000000000n,
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
            borrowFactor: 100,
            oraclePubkeys: [PublicKey.unique()],
            liquidityDecimals: 9,
            collateralDecimals: 9,
            cumulativeBorrowRate: 10000000000n,
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
          borrowedAmount: "1000000000000000000", // 0.1 SOL
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
            liquidationThreshold: 60, // Low liquidation threshold
            liquidationBonus: 500,
            borrowFactor: 100,
            oraclePubkeys: [PublicKey.unique()],
            liquidityDecimals: 9,
            collateralDecimals: 9,
            cumulativeBorrowRate: 10000000000n,
            scopePriceChain: null,
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
            borrowFactor: 100,
            oraclePubkeys: [PublicKey.unique()],
            liquidityDecimals: 6,
            collateralDecimals: 6,
            cumulativeBorrowRate: 10000000000n,
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
          borrowedAmount: "1000000000000000000", // 100 USDC
        },
      ];

      const result = computeHealthRatio({
        deposits,
        borrows,
        reserves,
        prices,
      });

      // Deposit: 0.5 SOL * ($100 - $0.01) * 0.6 liquidationThreshold = $29.997 weighted collateral
      // Borrow: 100 USDC * ($1 + $0.0001) * 1.0 borrowFactor = $100.01 weighted borrow
      // Health ratio: $29.997 / $100.01 ≈ 0.30 (underwater)
      expect(result.collateralValue).toBeCloseTo(29.997, 1);
      expect(result.borrowValue).toBeCloseTo(100.01, 1);
      expect(result.healthRatio).toBeCloseTo(0.30, 1);
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
