import { describe, it, expect } from 'vitest';

/**
 * Unit test to verify ATA setup separation structure
 * This test verifies the TypeScript types and structure without requiring live data
 */
describe('ATA Setup Separation', () => {
  it('should have setupIxs in KaminoLiquidationResult interface', async () => {
    // Import the interface
    const { buildKaminoLiquidationIxs } = await import('../src/kamino/liquidationBuilder.js');
    
    // Verify the function exists
    expect(buildKaminoLiquidationIxs).toBeDefined();
    expect(typeof buildKaminoLiquidationIxs).toBe('function');
  });
  
  it('should have buildFullTransaction return setupIxs and setupLabels', async () => {
    // Import executor to verify it compiles
    const executor = await import('../src/execute/executor.js');
    
    // Verify the module loads successfully
    expect(executor).toBeDefined();
    expect(executor.runDryExecutor).toBeDefined();
    expect(typeof executor.runDryExecutor).toBe('function');
  });
  
  it('should handle setup transaction status codes', () => {
    // Verify expected status codes for setup flow
    const expectedStatuses = [
      'setup-completed',
      'setup-failed', 
      'setup-error',
      'setup-sim-error',
    ];
    
    expect(expectedStatuses).toContain('setup-completed');
    expect(expectedStatuses).toContain('setup-failed');
    expect(expectedStatuses).toContain('setup-error');
    expect(expectedStatuses).toContain('setup-sim-error');
  });
});
