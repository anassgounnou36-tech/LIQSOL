import { describe, expect, it } from 'vitest';
import { buildExecutionResultEvent } from '../execute/executor.js';

describe('executor result emission helper', () => {
  it('builds execution-attempt-result event with plan base and extra fields', () => {
    const event = buildExecutionResultEvent(
      {
        planKey: 'plan-1',
        obligationPubkey: 'obligation-1',
        repayMint: 'USDC',
        collateralMint: 'SOL',
        ev: 10,
        ttlMin: 1,
        ttlStr: '1m',
        hazard: 0.5,
        broadcast: true,
        dry: false,
        estimatedProfitUsd: 12,
        estimatedCostUsd: 4,
        estimatedNetUsd: 8,
        expectedValueUsd: 10,
      },
      'confirmed',
      {
        signature: 'sig-1',
        slot: 123,
        chainFeeLamports: 5000,
      },
    );

    expect(event.kind).toBe('execution-attempt-result');
    expect(event.status).toBe('confirmed');
    expect(event.signature).toBe('sig-1');
    expect(event.slot).toBe(123);
    expect(event.chainFeeLamports).toBe(5000);
    expect(event.planKey).toBe('plan-1');
  });
});
