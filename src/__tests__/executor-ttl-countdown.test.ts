import { describe, expect, it } from 'vitest';
import { computeTtlRemainingMin } from '../execute/executor.js';

describe('executor TTL remaining countdown', () => {
  it('decreases remaining TTL based on ttlComputedAtMs over time', () => {
    const t0 = 1_700_000_000_000;
    const plan = {
      ttlMin: 10,
      ttlComputedMin: 10,
      ttlComputedAtMs: t0,
      createdAtMs: t0,
    };

    expect(computeTtlRemainingMin(plan, t0)).toBeCloseTo(10, 6);
    expect(computeTtlRemainingMin(plan, t0 + 3 * 60_000)).toBeCloseTo(7, 6);
    expect(computeTtlRemainingMin(plan, t0 + 12 * 60_000)).toBe(0);
  });
});
