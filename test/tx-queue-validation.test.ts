/**
 * Unit tests for tx_queue validation to prevent incomplete plans
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { enqueuePlans } from "../src/scheduler/txScheduler.js";
import type { FlashloanPlan } from "../src/scheduler/txBuilder.js";

const QUEUE_PATH = path.join(process.cwd(), 'data', 'tx_queue.json');

describe("TX Queue Validation", () => {
  beforeEach(() => {
    // Clean up before each test
    if (fs.existsSync(QUEUE_PATH)) {
      fs.unlinkSync(QUEUE_PATH);
    }
  });

  afterEach(() => {
    // Clean up after each test
    if (fs.existsSync(QUEUE_PATH)) {
      fs.unlinkSync(QUEUE_PATH);
    }
  });
  it("should accept complete plans with all required fields", () => {
    const plans: FlashloanPlan[] = [
      {
        planVersion: 2,
        key: "CompleteObligation",
        obligationPubkey: "CompleteObligation",
        ownerPubkey: "Owner123",
        mint: "USDC",
        amountUsd: 1000,
        repayMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mint pubkey
        collateralMint: "So11111111111111111111111111111111111111112", // SOL mint pubkey
        repayReservePubkey: "RepayReserve123",
        collateralReservePubkey: "CollateralReserve456",
        ev: 10,
        hazard: 0.5,
        ttlMin: 5,
        createdAtMs: Date.now(),
        liquidationEligible: true,
      },
    ];

    // Mock console.log to capture output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      const result = enqueuePlans(plans);

      expect(result.length).toBe(1);
      expect(result[0].key).toBe("CompleteObligation");
      
      // Should not have any skip messages
      const skipLogs = logs.filter(l => l.includes("skip_incomplete_plan"));
      expect(skipLogs.length).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });

  it("should skip plans with missing repayReservePubkey", () => {
    const plans: FlashloanPlan[] = [
      {
        planVersion: 2,
        key: "IncompletePlan1",
        obligationPubkey: "IncompletePlan1",
        mint: "USDC",
        amountUsd: 1000,
        repayMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        collateralMint: "So11111111111111111111111111111111111111112",
        // Missing repayReservePubkey
        collateralReservePubkey: "CollateralReserve456",
        ev: 10,
        hazard: 0.5,
        ttlMin: 5,
        createdAtMs: Date.now(),
        liquidationEligible: true,
      },
    ];

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      const result = enqueuePlans(plans);

      expect(result.length).toBe(0);
      
      const skipLogs = logs.filter(l => l.includes("skip_incomplete_plan"));
      expect(skipLogs.length).toBeGreaterThan(0);
      expect(skipLogs[0]).toContain("IncompletePlan1");
      expect(skipLogs[0]).toContain("repayReserve=missing");
    } finally {
      console.log = originalLog;
    }
  });

  it("should skip plans with missing collateralReservePubkey", () => {
    const plans: FlashloanPlan[] = [
      {
        planVersion: 2,
        key: "IncompletePlan2",
        obligationPubkey: "IncompletePlan2",
        mint: "USDC",
        amountUsd: 1000,
        repayMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        collateralMint: "So11111111111111111111111111111111111111112",
        repayReservePubkey: "RepayReserve123",
        // Missing collateralReservePubkey
        ev: 10,
        hazard: 0.5,
        ttlMin: 5,
        createdAtMs: Date.now(),
        liquidationEligible: true,
      },
    ];

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      const result = enqueuePlans(plans);

      expect(result.length).toBe(0);
      
      const skipLogs = logs.filter(l => l.includes("skip_incomplete_plan"));
      expect(skipLogs.length).toBeGreaterThan(0);
      expect(skipLogs[0]).toContain("collateralReserve=missing");
    } finally {
      console.log = originalLog;
    }
  });

  it("should skip plans with empty collateralMint", () => {
    const plans: FlashloanPlan[] = [
      {
        planVersion: 2,
        key: "IncompletePlan3",
        obligationPubkey: "IncompletePlan3",
        mint: "USDC",
        amountUsd: 1000,
        repayMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        collateralMint: "", // Empty string
        repayReservePubkey: "RepayReserve123",
        collateralReservePubkey: "CollateralReserve456",
        ev: 10,
        hazard: 0.5,
        ttlMin: 5,
        createdAtMs: Date.now(),
        liquidationEligible: true,
      },
    ];

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      const result = enqueuePlans(plans);

      expect(result.length).toBe(0);
      
      const skipLogs = logs.filter(l => l.includes("skip_incomplete_plan"));
      expect(skipLogs.length).toBeGreaterThan(0);
      expect(skipLogs[0]).toContain("collateralMint=missing");
    } finally {
      console.log = originalLog;
    }
  });

  it("should accept only complete plans and skip incomplete ones", () => {
    const plans: FlashloanPlan[] = [
      // Complete plan
      {
        planVersion: 2,
        key: "CompletePlan",
        obligationPubkey: "CompletePlan",
        mint: "USDC",
        amountUsd: 1000,
        repayMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        collateralMint: "So11111111111111111111111111111111111111112",
        repayReservePubkey: "RepayReserve123",
        collateralReservePubkey: "CollateralReserve456",
        ev: 10,
        hazard: 0.5,
        ttlMin: 5,
        createdAtMs: Date.now(),
        liquidationEligible: true,
      },
      // Incomplete plan (missing collateralMint)
      {
        planVersion: 2,
        key: "IncompletePlan",
        obligationPubkey: "IncompletePlan",
        mint: "USDC",
        amountUsd: 500,
        repayMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        collateralMint: "",
        repayReservePubkey: "RepayReserve789",
        collateralReservePubkey: "CollateralReserve012",
        ev: 5,
        hazard: 0.3,
        ttlMin: 3,
        createdAtMs: Date.now(),
        liquidationEligible: false,
      },
    ];

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(" "));

    try {
      const result = enqueuePlans(plans);

      // Only the complete plan should be enqueued
      expect(result.length).toBe(1);
      expect(result[0].key).toBe("CompletePlan");
      
      // Should have skip messages
      const skipLogs = logs.filter(l => l.includes("skip_incomplete_plan"));
      expect(skipLogs.length).toBeGreaterThan(0);
      expect(skipLogs[0]).toContain("IncompletePlan");
    } finally {
      console.log = originalLog;
    }
  });
});
