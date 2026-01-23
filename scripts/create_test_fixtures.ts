import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Buffer } from "buffer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load the klend IDL
const idlPath = join(__dirname, "../src/kamino/idl/klend.json");
const idlJson = JSON.parse(readFileSync(idlPath, "utf-8"));

// Create Borsh Coder
const accountsCoder = new BorshAccountsCoder(idlJson);

// Constants
const MARKET_PUBKEY = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const WSOL_RESERVE = "4UpD2fh7xH3GVMoZmZ3jb3XgDSVvWAYBP5c8DOffcKEV";
const USDC_RESERVE = "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q";

// Helper to create public keys
function pk(str: string): PublicKey {
  return new PublicKey(str);
}

// Helper for BigInt with proper BN compatibility
function bn(num: number | bigint): any {
  if (typeof num === "bigint") {
    return num;
  }
  return BigInt(num);
}

// Create a mock Reserve
function createReserveFixture() {
  console.log("Creating Reserve account data...");

  const reserveData = {
    version: 1,
    lastUpdate: {
      slot: bn(200000),
      stale: false,
    },
    lendingMarket: pk(MARKET_PUBKEY),
    borrowLimit: bn(0),
    borrowLimitOutstandingAmount: bn(0),
    borrowLimitBorrowWeightScale: bn(100),
    borrowLimitDepositWeightScale: bn(100),
    liquidity: {
      mintPubkey: pk(USDC_MINT),
      mintDecimals: 6,
      supplyVault: pk("FscwFpEfWJ2zX91z7YqK3qMLxVwLfLNaDcA4yvhB2RJw"),
      feeVault: pk("2nqfzPz1e9vfePqaZLG4bEMCkG9v9LQKH9FVfZGLzp7S"),
      availableAmount: bn(1000000000000),
      borrowedAmountSf: bn(100000000000),
      cumulativeBorrowRateWads: bn("1000000000000000000"),
      marketPrice: bn(100000000),
      marketPriceSf: bn(100000000),
      depositLimit: bn(1000000000000),
      borrowLimit: bn(1000000000000),
      depositLimitCrossChain: bn(1000000000000),
      borrowLimitCrossChain: bn(1000000000000),
    },
    collateral: {
      mintPubkey: pk("CqzBE1mnV3P3kAyksxV2fWRFbvxJ8bHMk3a2AYJ8Nq6D"),
      mintDecimals: 6,
      supplyVault: pk("FscwFpEfWJ2zX91z7YqK3qMLxVwLfLNaDcA4yvhB2RJw"),
    },
    config: {
      loanToValuePct: 80,
      liquidationThresholdPct: 85,
      liquidationBonusBps: 1000,
      reserveFees: {
        borrowFeeWad: bn("100000000000000"),
        flashLoanFeeWad: bn(0),
        hostFeePercentage: 20,
      },
      depositLimit: bn(1000000000000),
      borrowLimit: bn(1000000000000),
      maxLiquidationBonusBps: 1000,
      depositLimitCrossChain: bn(1000000000000),
      borrowLimitCrossChain: bn(1000000000000),
      tokenInfo: {
        pythConfiguration: {
          price: pk("Gnt27xtC473ZT2Mw5u8wZ7UcVrFq3ZWd6sqC5CNTc1gw"),
        },
        switchboardConfiguration: {
          priceAggregator: pk("11111111111111111111111111111111"),
          twapAggregator: pk("11111111111111111111111111111111"),
        },
        scopeConfiguration: {
          priceFeed: pk("11111111111111111111111111111111"),
        },
      },
      borrowLimitOutstandingAmount: bn(0),
      borrowLimitBorrowWeightScale: bn(100),
      borrowLimitDepositWeightScale: bn(100),
      proportionalDepositLimit: bn(1),
      proportionalBorrowLimit: bn(1),
    },
    minRentExemption: bn(2039280),
    depositedAmount: bn(10000000000),
    borrowedAmount: bn(1000000000),
    cumulativeBorrowRateWads: bn("1000000000000000000"),
    lastPriceWads: bn("100000000000000000"),
    lastPriceSf: bn(100000000),
    lastTvlWad: bn("10000000000000000000"),
    lastTvlSf: bn(100000000),
    lastUpdateSlot: bn(200000),
    totalBorrowedSf: bn(100000000000),
  };

  try {
    const encoded = accountsCoder.encode("Reserve", reserveData);
    const fixture = {
      pubkey: USDC_RESERVE,
      note: "Mock USDC Reserve from Kamino Main Market for testing",
      data_base64: Buffer.from(encoded).toString("base64"),
      expected: {
        market: MARKET_PUBKEY,
        liquidityMint: USDC_MINT,
      },
    };

    const fixturePath = join(__dirname, "../test/fixtures/reserve_usdc.json");
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
    console.log("✓ Reserve fixture saved to", fixturePath);
  } catch (error) {
    console.error("✗ Error creating reserve fixture:", error);
  }
}

// Create a mock Obligation
function createObligationFixture() {
  console.log("Creating Obligation account data...");

  const obligationData = {
    tag: 0,
    lastUpdate: {
      slot: bn(200000),
      stale: false,
    },
    lendingMarket: pk(MARKET_PUBKEY),
    owner: pk("9B5X73oM67dXy2ETCSGPzTBEqSzrdyvWxXJ5g8hVcabK"),
    deposits: [
      {
        depositReserve: pk(WSOL_RESERVE),
        depositedAmount: bn(100000000000),
        marketValueSf: bn(100000000),
        marketPrice: bn(100000000),
      },
    ],
    borrows: [
      {
        borrowReserve: pk(USDC_RESERVE),
        borrowedAmountSf: bn(10000000000),
        marketValueSf: bn(10000000),
        marketPrice: bn(100000000),
        cumulativeBorrowRateWads: bn("1000000000000000000"),
      },
    ],
  };

  try {
    const encoded = accountsCoder.encode("Obligation", obligationData);
    const fixture = {
      pubkey: "AYgFzMvCnMpNBRPFSHvvMVsBfuCgBLG6bBqvXXGXj2dh",
      note: "Mock Obligation with SOL collateral and USDC debt for testing",
      data_base64: Buffer.from(encoded).toString("base64"),
      expected: {
        market: MARKET_PUBKEY,
      },
    };

    const fixturePath = join(__dirname, "../test/fixtures/obligation_usdc_debt.json");
    writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
    console.log("✓ Obligation fixture saved to", fixturePath);
  } catch (error) {
    console.error("✗ Error creating obligation fixture:", error);
  }
}

createReserveFixture();
createObligationFixture();
