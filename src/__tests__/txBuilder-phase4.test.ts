import { describe, it, expect } from 'vitest';
import { buildPlanFromCandidate, recomputePlanFields, type FlashloanPlan } from '../scheduler/txBuilder.js';

describe('txBuilder Phase 4 guards', () => {
  it('preserves fields when recomputing without candidate data', () => {
    const before: FlashloanPlan = {
      planVersion: 2,
      key: 'obligation-1',
      obligationPubkey: 'obligation-1',
      mint: 'USDC',
      amountUsd: 123.45,
      amountUi: '123.45',
      repayMint: 'repay-mint',
      collateralMint: 'collateral-mint',
      ev: 9.87,
      hazard: 0.42,
      ttlMin: 5,
      ttlStr: '5m',
      createdAtMs: 1,
      liquidationEligible: true,
      assets: ['mint-a', 'mint-b'],
    };

    const after = recomputePlanFields(before, undefined);

    expect(after.ev).toBe(before.ev);
    expect(after.hazard).toBe(before.hazard);
    expect(after.ttlMin).toBe(before.ttlMin);
    expect(after.assets).toEqual(before.assets);
  });

  it('propagates assets from candidate into built plan', () => {
    const plan = buildPlanFromCandidate({
      obligationPubkey: 'obligation-2',
      ownerPubkey: 'owner-2',
      borrowValueUsd: 50,
      primaryBorrowMint: 'borrow-mint',
      primaryCollateralMint: 'collateral-mint',
      assets: ['mint-x', 'mint-y'],
    });

    expect(plan.assets).toEqual(['mint-x', 'mint-y']);
  });
});
