import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { enqueuePlans, loadQueue, saveQueue } from '../scheduler/txScheduler.js';
import type { FlashloanPlan } from '../scheduler/txBuilder.js';

const TEST_QUEUE_PATH = path.join(process.cwd(), 'data', 'tx_queue.json');

describe('txScheduler - legacy plan purge', () => {
  beforeEach(() => {
    // Clean up queue before each test
    if (fs.existsSync(TEST_QUEUE_PATH)) {
      fs.unlinkSync(TEST_QUEUE_PATH);
    }
  });

  it('should drop legacy/incomplete plans with missing repayReservePubkey', () => {
    // Create a legacy plan with missing repayReservePubkey
    const legacyPlan: FlashloanPlan = {
      key: 'legacy-plan-1',
      obligationPubkey: 'test-obligation-1',
      ownerPubkey: 'test-owner',
      repayReservePubkey: '', // MISSING
      collateralReservePubkey: 'test-collateral-reserve',
      collateralMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      ev: 10,
      hazard: 0.5,
      ttlMin: 60,
      ttlStr: '1h',
      liquidationEligible: false,
    } as FlashloanPlan;

    // Save legacy plan to queue
    saveQueue([legacyPlan]);
    
    // Enqueue new plans (should trigger legacy purge)
    const newPlan: FlashloanPlan = {
      key: 'new-plan-1',
      obligationPubkey: 'test-obligation-2',
      ownerPubkey: 'test-owner',
      repayReservePubkey: 'test-repay-reserve',
      collateralReservePubkey: 'test-collateral-reserve',
      collateralMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      ev: 20,
      hazard: 0.7,
      ttlMin: 30,
      ttlStr: '30m',
      liquidationEligible: true,
    } as FlashloanPlan;

    const result = enqueuePlans([newPlan]);

    // Legacy plan should be dropped, only new plan should remain
    expect(result.length).toBe(1);
    expect(result[0].key).toBe('new-plan-1');
  });

  it('should drop legacy/incomplete plans with missing collateralMint', () => {
    const legacyPlan: FlashloanPlan = {
      key: 'legacy-plan-2',
      obligationPubkey: 'test-obligation-1',
      ownerPubkey: 'test-owner',
      repayReservePubkey: 'test-repay-reserve',
      collateralReservePubkey: 'test-collateral-reserve',
      collateralMint: '', // MISSING
      ev: 10,
      hazard: 0.5,
      ttlMin: 60,
      ttlStr: '1h',
      liquidationEligible: false,
    } as FlashloanPlan;

    saveQueue([legacyPlan]);

    const newPlan: FlashloanPlan = {
      key: 'new-plan-2',
      obligationPubkey: 'test-obligation-2',
      ownerPubkey: 'test-owner',
      repayReservePubkey: 'test-repay-reserve',
      collateralReservePubkey: 'test-collateral-reserve',
      collateralMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      ev: 20,
      hazard: 0.7,
      ttlMin: 30,
      ttlStr: '30m',
      liquidationEligible: true,
    } as FlashloanPlan;

    const result = enqueuePlans([newPlan]);

    expect(result.length).toBe(1);
    expect(result[0].key).toBe('new-plan-2');
  });

  it('should keep complete legacy plans', () => {
    const completeLegacyPlan: FlashloanPlan = {
      key: 'complete-legacy-plan',
      obligationPubkey: 'test-obligation-1',
      ownerPubkey: 'test-owner',
      repayReservePubkey: 'test-repay-reserve',
      collateralReservePubkey: 'test-collateral-reserve',
      collateralMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      ev: 10,
      hazard: 0.5,
      ttlMin: 60,
      ttlStr: '1h',
      liquidationEligible: false,
    } as FlashloanPlan;

    saveQueue([completeLegacyPlan]);

    const newPlan: FlashloanPlan = {
      key: 'new-plan-3',
      obligationPubkey: 'test-obligation-2',
      ownerPubkey: 'test-owner',
      repayReservePubkey: 'test-repay-reserve',
      collateralReservePubkey: 'test-collateral-reserve',
      collateralMint: 'So11111111111111111111111111111111111111112',
      ev: 20,
      hazard: 0.7,
      ttlMin: 30,
      ttlStr: '30m',
      liquidationEligible: true,
    } as FlashloanPlan;

    const result = enqueuePlans([newPlan]);

    // Both plans should be in queue
    expect(result.length).toBe(2);
    expect(result.map(p => p.key).sort()).toEqual(['complete-legacy-plan', 'new-plan-3'].sort());
  });

  it('should skip incomplete new plans', () => {
    const incompletePlan: FlashloanPlan = {
      key: 'incomplete-new-plan',
      obligationPubkey: 'test-obligation-1',
      ownerPubkey: 'test-owner',
      repayReservePubkey: 'test-repay-reserve',
      collateralReservePubkey: '', // MISSING
      collateralMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      ev: 10,
      hazard: 0.5,
      ttlMin: 60,
      ttlStr: '1h',
      liquidationEligible: false,
    } as FlashloanPlan;

    const result = enqueuePlans([incompletePlan]);

    // Incomplete plan should be skipped
    expect(result.length).toBe(0);
  });
});
