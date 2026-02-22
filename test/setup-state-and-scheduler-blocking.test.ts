import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { markBlocked, isBlocked, loadSetupState } from '../src/state/setupState.js';
import { downgradeBlockedPlan, loadQueue, saveQueue } from '../src/scheduler/txScheduler.js';
import type { FlashloanPlan } from '../src/scheduler/txBuilder.js';

const SETUP_STATE_PATH = path.join(process.cwd(), 'data', 'setup_state.json');
const QUEUE_PATH = path.join(process.cwd(), 'data', 'tx_queue.json');

afterEach(() => {
  if (fs.existsSync(SETUP_STATE_PATH)) fs.unlinkSync(SETUP_STATE_PATH);
  if (fs.existsSync(QUEUE_PATH)) fs.unlinkSync(QUEUE_PATH);
});

describe('setup state + blocked-plan downgrade', () => {
  it('persists blocked plan state', () => {
    markBlocked('plan-1', 'insufficient-rent');
    const state = loadSetupState();
    expect(state.blocked['plan-1']?.reason).toBe('insufficient-rent');
    expect(isBlocked('plan-1')).toBe(true);
  });

  it('downgrades blocked plan in queue', async () => {
    const plan: FlashloanPlan = {
      planVersion: 2,
      key: 'plan-2',
      obligationPubkey: 'obligation-pubkey-2',
      mint: 'USDC',
      amountUsd: 100,
      repayMint: 'repay-mint',
      collateralMint: 'collateral-mint',
      repayReservePubkey: 'repay-reserve',
      collateralReservePubkey: 'collateral-reserve',
      ev: 1,
      hazard: 0.2,
      ttlMin: 1,
      createdAtMs: Date.now(),
      liquidationEligible: true,
    };
    saveQueue([plan]);
    await downgradeBlockedPlan('plan-2');
    const updated = loadQueue();
    expect(updated[0]?.ttlMin).toBe(999999);
    expect(updated[0]?.ttlStr).toBe('blocked-insufficient-rent');
    expect(updated[0]?.liquidationEligible).toBe(false);
  });

  it('downgrades blocked plan with custom blocked reason in ttlStr', async () => {
    const plan: FlashloanPlan = {
      planVersion: 2,
      key: 'plan-3',
      obligationPubkey: 'obligation-pubkey-3',
      mint: 'USDC',
      amountUsd: 100,
      repayMint: 'repay-mint',
      collateralMint: 'collateral-mint',
      repayReservePubkey: 'repay-reserve',
      collateralReservePubkey: 'collateral-reserve',
      ev: 1,
      hazard: 0.2,
      ttlMin: 1,
      createdAtMs: Date.now(),
      liquidationEligible: true,
    };
    saveQueue([plan]);
    await downgradeBlockedPlan('plan-3', 'obligation-market-mismatch');
    const updated = loadQueue();
    expect(updated[0]?.ttlMin).toBe(999999);
    expect(updated[0]?.ttlStr).toBe('obligation-market-mismatch');
    expect(updated[0]?.liquidationEligible).toBe(false);
  });
});
