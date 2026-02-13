import { describe, it, expect } from 'vitest';
import { buildComputeBudgetIxs } from '../src/execution/computeBudget.js';

describe('Compute Budget Instructions Labeling', () => {
  it('should return 1 instruction when cuPriceMicroLamports is 0', () => {
    const ixs = buildComputeBudgetIxs({
      cuLimit: 600_000,
      cuPriceMicroLamports: 0,
    });
    
    expect(ixs).toHaveLength(1);
    // Only the limit instruction should be present
  });

  it('should return 2 instructions when cuPriceMicroLamports is greater than 0', () => {
    const ixs = buildComputeBudgetIxs({
      cuLimit: 600_000,
      cuPriceMicroLamports: 1000,
    });
    
    expect(ixs).toHaveLength(2);
    // Both limit and price instructions should be present
  });

  it('should return 1 instruction with default values (cuPriceMicroLamports defaults to 0)', () => {
    const ixs = buildComputeBudgetIxs({
      cuLimit: 600_000,
    });
    
    expect(ixs).toHaveLength(1);
  });

  it('should return 1 instruction when no options provided (both defaults)', () => {
    const ixs = buildComputeBudgetIxs();
    
    expect(ixs).toHaveLength(1);
    // Default cuPriceMicroLamports is 0, so only limit instruction
  });
});
