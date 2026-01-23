import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "fs";
import crypto from "crypto";
import { Buffer } from "buffer";

// Load the klend IDL
const idlJson = JSON.parse(readFileSync("src/kamino/idl/klend.json", "utf-8"));

// Create Borsh Coder
const accountsCoder = new BorshAccountsCoder(idlJson);

// Helper to get discriminator
function anchorDiscriminator(name) {
  const preimage = `account:${name}`;
  const hash = crypto.createHash("sha256").update(preimage).digest();
  return hash.subarray(0, 8);
}

async function main() {
  try {
    // Test encoding a minimal Reserve
    console.log("Testing Reserve account encoding...");
    
    const testReserveData = {
      version: 1,
      lastUpdate: {
        slot: { toNumber: () => 200000, toString: () => "200000" },
        stale: false,
      },
      lendingMarket: new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"),
      farmCollateral: new PublicKey("11111111111111111111111111111111"),
      farmDebt: new PublicKey("11111111111111111111111111111111"),
      borrowLimit: { toNumber: () => 0, toString: () => "0" },
      borrowLimitOutstandingAmount: { toNumber: () => 0, toString: () => "0" },
      borrowLimitBorrowWeightScale: { toNumber: () => 100, toString: () => "100" },
      borrowLimitDepositWeightScale: { toNumber: () => 100, toString: () => "100" },
      liquidity: {
        mintPubkey: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
        mintDecimals: 6,
        supplyVault: new PublicKey("FscwFpEfWJ2zX91z7YqK3qMLxVwLfLNaDcA4yvhB2RJw"),
        feeVault: new PublicKey("2nqfzPz1e9vfePqaZLG4bEMCkG9v9LQKH9FVfZGLzp7S"),
        availableAmount: { toNumber: () => 1000000000000, toString: () => "1000000000000" },
        borrowedAmountSf: { toNumber: () => 100000000000, toString: () => "100000000000" },
        cumulativeBorrowRateWads: { toNumber: () => 1000000000000000000, toString: () => "1000000000000000000" },
        marketPrice: { toNumber: () => 100000000, toString: () => "100000000" },
        marketPriceSf: { toNumber: () => 100000000, toString: () => "100000000" },
        depositLimit: { toNumber: () => 1000000000000, toString: () => "1000000000000" },
        borrowLimit: { toNumber: () => 1000000000000, toString: () => "1000000000000" },
        depositLimitCrossChain: { toNumber: () => 1000000000000, toString: () => "1000000000000" },
        borrowLimitCrossChain: { toNumber: () => 1000000000000, toString: () => "1000000000000" },
      },
      collateral: {
        mintPubkey: new PublicKey("CqzBE1mnV3P3kAyksxV2fWRFbvxJ8bHMk3a2AYJ8Nq6D"),
        mintDecimals: 6,
        supplyVault: new PublicKey("FscwFpEfWJ2zX91z7YqK3qMLxVwLfLNaDcA4yvhB2RJw"),
      },
      config: {
        loanToValuePct: 80,
        liquidationThresholdPct: 85,
        liquidationBonusBps: 1000,
        reserveFees: {
          borrowFeeWad: { toNumber: () => 100000000000000, toString: () => "100000000000000" },
          flashLoanFeeWad: { toNumber: () => 0, toString: () => "0" },
          hostFeePercentage: 20,
        },
        depositLimit: { toNumber: () => 1000000000000, toString: () => "1000000000000" },
        borrowLimit: { toNumber: () => 1000000000000, toString: () => "1000000000000" },
        maxLiquidationBonusBps: 1000,
        depositLimitCrossChain: { toNumber: () => 1000000000000, toString: () => "1000000000000" },
        borrowLimitCrossChain: { toNumber: () => 1000000000000, toString: () => "1000000000000" },
        tokenInfo: {
          pythConfiguration: {
            price: new PublicKey("Gnt27xtC473ZT2Mw5u8wZ7UcVrFq3ZWd6sqC5CNTc1gw"),
          },
          switchboardConfiguration: {
            priceAggregator: new PublicKey("11111111111111111111111111111111"),
            twapAggregator: new PublicKey("11111111111111111111111111111111"),
          },
          scopeConfiguration: {
            priceFeed: new PublicKey("11111111111111111111111111111111"),
          },
        },
        borrowLimitOutstandingAmount: { toNumber: () => 0, toString: () => "0" },
        borrowLimitBorrowWeightScale: { toNumber: () => 100, toString: () => "100" },
        borrowLimitDepositWeightScale: { toNumber: () => 100, toString: () => "100" },
        proportionalDepositLimit: { toNumber: () => 1, toString: () => "1" },
        proportionalBorrowLimit: { toNumber: () => 1, toString: () => "1" },
      },
      minRentExemption: { toNumber: () => 2039280, toString: () => "2039280" },
      depositedAmount: { toNumber: () => 10000000000, toString: () => "10000000000" },
      borrowedAmount: { toNumber: () => 1000000000, toString: () => "1000000000" },
      cumulativeBorrowRateWads: { toNumber: () => 1000000000000000000, toString: () => "1000000000000000000" },
      lastPriceWads: { toNumber: () => 100000000000000000, toString: () => "100000000000000000" },
      lastPriceSf: { toNumber: () => 100000000, toString: () => "100000000" },
      lastTvlWad: { toNumber: () => 10000000000000000000, toString: () => "10000000000000000000" },
      lastTvlSf: { toNumber: () => 100000000, toString: () => "100000000" },
      lastUpdateSlot: { toNumber: () => 200000, toString: () => "200000" },
      totalBorrowedSf: { toNumber: () => 100000000000, toString: () => "100000000000" },
    };
    
    const encoded = await accountsCoder.encode("Reserve", testReserveData);
    console.log("✓ Reserve encoding successful, size:", encoded.length);
    
    // Verify discriminator
    const disc = anchorDiscriminator("Reserve");
    console.log("  Discriminator matches:", Buffer.from(encoded.slice(0, 8)).equals(disc));
    
  } catch (error) {
    console.error("✗ Error:", error.message);
    console.error(error.stack);
  }
}

main().catch(console.error);
