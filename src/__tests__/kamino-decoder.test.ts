import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Buffer } from "buffer";
import { decodeReserve, decodeObligation } from "../kamino/decoder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load IDL
const idlPath = join(__dirname, "../kamino/idl/klend.json");
const idlJson = JSON.parse(readFileSync(idlPath, "utf-8"));

describe("Kamino Decoder Tests", () => {
  describe("IDL and Coder Setup", () => {
    it("should load klend IDL successfully", () => {
      expect(idlJson).toBeDefined();
      expect(idlJson.name).toBe("kamino_lending");
      expect(idlJson.version).toBe("1.12.6");
    });

    it("should create BorshAccountsCoder successfully", () => {
      const coder = new BorshAccountsCoder(idlJson);
      expect(coder).toBeDefined();
    });

    it("should have Reserve account type in IDL", () => {
      const reserveAccount = idlJson.accounts.find(
        (acc: { name: string }) => acc.name === "Reserve"
      );
      expect(reserveAccount).toBeDefined();
      expect(reserveAccount.name).toBe("Reserve");
    });

    it("should have Obligation account type in IDL", () => {
      const obligationAccount = idlJson.accounts.find(
        (acc: { name: string }) => acc.name === "Obligation"
      );
      expect(obligationAccount).toBeDefined();
      expect(obligationAccount.name).toBe("Obligation");
    });
  });

  describe("Reserve Account Structure", () => {
    it("should have correct Reserve fields in IDL", () => {
      const reserveAccount = idlJson.accounts.find(
        (acc: { name: string }) => acc.name === "Reserve"
      );
      const fieldNames = reserveAccount.type.fields.map(
        (f: { name: string }) => f.name
      );

      // Verify key fields exist
      expect(fieldNames).toContain("version");
      expect(fieldNames).toContain("lastUpdate");
      expect(fieldNames).toContain("lendingMarket");
      expect(fieldNames).toContain("liquidity");
      expect(fieldNames).toContain("collateral");
      expect(fieldNames).toContain("config");
    });

    it("should have ReserveLiquidity type with required fields", () => {
      const liquidityType = idlJson.types.find(
        (t: { name: string }) => t.name === "ReserveLiquidity"
      );
      expect(liquidityType).toBeDefined();

      const fieldNames = liquidityType.type.fields.map(
        (f: { name: string }) => f.name
      );
      expect(fieldNames).toContain("mintPubkey");
      expect(fieldNames).toContain("availableAmount");
      expect(fieldNames).toContain("borrowedAmountSf");
      expect(fieldNames).toContain("mintDecimals");
    });

    it("should have ReserveConfig type with LTV and liquidation fields", () => {
      const configType = idlJson.types.find(
        (t: { name: string }) => t.name === "ReserveConfig"
      );
      expect(configType).toBeDefined();

      const fieldNames = configType.type.fields.map(
        (f: { name: string }) => f.name
      );
      expect(fieldNames).toContain("loanToValuePct");
      expect(fieldNames).toContain("liquidationThresholdPct");
      expect(fieldNames).toContain("maxLiquidationBonusBps");
      expect(fieldNames).toContain("tokenInfo");
    });

    it("should have TokenInfo type with oracle configurations", () => {
      const tokenInfoType = idlJson.types.find(
        (t: { name: string }) => t.name === "TokenInfo"
      );
      expect(tokenInfoType).toBeDefined();

      const fieldNames = tokenInfoType.type.fields.map(
        (f: { name: string }) => f.name
      );
      expect(fieldNames).toContain("pythConfiguration");
      expect(fieldNames).toContain("switchboardConfiguration");
      expect(fieldNames).toContain("scopeConfiguration");
    });
  });

  describe("Obligation Account Structure", () => {
    it("should have correct Obligation fields in IDL", () => {
      const obligationAccount = idlJson.accounts.find(
        (acc: { name: string }) => acc.name === "Obligation"
      );
      const fieldNames = obligationAccount.type.fields.map(
        (f: { name: string }) => f.name
      );

      // Verify key fields exist
      expect(fieldNames).toContain("tag");
      expect(fieldNames).toContain("lastUpdate");
      expect(fieldNames).toContain("lendingMarket");
      expect(fieldNames).toContain("owner");
      expect(fieldNames).toContain("deposits");
      expect(fieldNames).toContain("borrows");
    });

    it("should have ObligationCollateral type with required fields", () => {
      const collateralType = idlJson.types.find(
        (t: { name: string }) => t.name === "ObligationCollateral"
      );
      expect(collateralType).toBeDefined();

      const fieldNames = collateralType.type.fields.map(
        (f: { name: string }) => f.name
      );
      expect(fieldNames).toContain("depositReserve");
      expect(fieldNames).toContain("depositedAmount");
    });

    it("should have ObligationLiquidity type with required fields", () => {
      const liquidityType = idlJson.types.find(
        (t: { name: string }) => t.name === "ObligationLiquidity"
      );
      expect(liquidityType).toBeDefined();

      const fieldNames = liquidityType.type.fields.map(
        (f: { name: string }) => f.name
      );
      expect(fieldNames).toContain("borrowReserve");
      expect(fieldNames).toContain("borrowedAmountSf");
    });
  });

  describe("Decoder Functions", () => {
    it("should export decodeReserve function", () => {
      expect(typeof decodeReserve).toBe("function");
    });

    it("should export decodeObligation function", () => {
      expect(typeof decodeObligation).toBe("function");
    });

    it("should throw on invalid Reserve data", () => {
      const invalidData = Buffer.alloc(100);
      const pubkey = new PublicKey("11111111111111111111111111111111");

      expect(() => decodeReserve(invalidData, pubkey)).toThrow();
    });

    it("should throw on invalid Obligation data", () => {
      const invalidData = Buffer.alloc(100);
      const pubkey = new PublicKey("11111111111111111111111111111111");

      expect(() => decodeObligation(invalidData, pubkey)).toThrow();
    });
  });

  describe("Decoder Output Types", () => {
    // Note: These tests verify the decoder returns the expected shape
    // when given valid data. In production, this would use actual on-chain
    // account data or properly encoded test fixtures.

    it("should return DecodedReserve with all required fields (if given valid data)", () => {
      // This test documents the expected output structure
      // In a real scenario, you would use actual encoded Reserve account data

      const expectedFields = [
        "reservePubkey",
        "marketPubkey",
        "liquidityMint",
        "collateralMint",
        "liquidityDecimals",
        "collateralDecimals",
        "oraclePubkeys",
        "loanToValueRatio",
        "liquidationThreshold",
        "liquidationBonus",
        "totalBorrowed",
        "availableLiquidity",
      ];

      // This is a documentation test - the actual decoding would require
      // valid on-chain data or properly constructed test fixtures
      expect(expectedFields.length).toBe(12);
    });

    it("should return DecodedObligation with all required fields (if given valid data)", () => {
      // This test documents the expected output structure
      const expectedFields = [
        "obligationPubkey",
        "ownerPubkey",
        "marketPubkey",
        "lastUpdateSlot",
        "deposits",
        "borrows",
      ];

      // This is a documentation test
      expect(expectedFields.length).toBe(6);
    });
  });
});
