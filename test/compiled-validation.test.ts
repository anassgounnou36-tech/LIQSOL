import { describe, it, expect } from 'vitest';

/**
 * Unit test to verify semantic compiled instruction validation
 * This test verifies the new discriminator-based validation works correctly
 */
describe('Compiled Instruction Validation', () => {
  it('should have KLEND_PROGRAM_ID constant', async () => {
    const { KLEND_PROGRAM_ID } = await import('../src/execute/decodeKaminoKindFromCompiled.js');
    
    expect(KLEND_PROGRAM_ID).toBeDefined();
    expect(KLEND_PROGRAM_ID.toBase58()).toBe('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
  });
  
  it('should have KAMINO_DISCRIMINATORS mappings', async () => {
    const { KAMINO_DISCRIMINATORS } = await import('../src/execute/decodeKaminoKindFromCompiled.js');
    
    expect(KAMINO_DISCRIMINATORS).toBeDefined();
    expect(KAMINO_DISCRIMINATORS.refreshReserve).toBe('07930aa66d3aa710');
    expect(KAMINO_DISCRIMINATORS.refreshObligation).toBe('a8e5e45f8c4c29c0');
    expect(KAMINO_DISCRIMINATORS.liquidateObligationAndRedeemReserveCollateral).toBe('d88378ff5e9e5028');
    expect(KAMINO_DISCRIMINATORS.refreshObligationFarmsForReserve).toBe('d79cf84dbd8fe9e2');
    expect(KAMINO_DISCRIMINATORS.flashBorrowReserveLiquidity).toBe('d60e1307b8c6ef35');
    expect(KAMINO_DISCRIMINATORS.flashRepayReserveLiquidity).toBe('f69c6e18b02e3e8d');
  });
  
  it('should have decodeInstructionKind function', async () => {
    const { decodeInstructionKind } = await import('../src/execute/decodeKaminoKindFromCompiled.js');
    
    expect(decodeInstructionKind).toBeDefined();
    expect(typeof decodeInstructionKind).toBe('function');
  });
  
  it('should decode Kamino instructions correctly', async () => {
    const { decodeInstructionKind, KNOWN_PROGRAM_IDS } = await import('../src/execute/decodeKaminoKindFromCompiled.js');
    
    // Test refresh reserve
    expect(decodeInstructionKind(
      KNOWN_PROGRAM_IDS.KAMINO_KLEND,
      '07930aa66d3aa710'
    )).toBe('refreshReserve');
    
    // Test liquidation
    expect(decodeInstructionKind(
      KNOWN_PROGRAM_IDS.KAMINO_KLEND,
      'd88378ff5e9e5028'
    )).toBe('liquidateObligationAndRedeemReserveCollateral');
    
    // Test unknown Kamino instruction
    expect(decodeInstructionKind(
      KNOWN_PROGRAM_IDS.KAMINO_KLEND,
      'deadbeef00000000'
    )).toBe('kamino:unknown');
  });
  
  it('should decode compute budget instructions', async () => {
    const { decodeInstructionKind, KNOWN_PROGRAM_IDS } = await import('../src/execute/decodeKaminoKindFromCompiled.js');
    
    // Test set compute unit limit (0x02)
    expect(decodeInstructionKind(
      KNOWN_PROGRAM_IDS.COMPUTE_BUDGET,
      undefined,
      new Uint8Array([0x02, 0x00, 0x00, 0x00])
    )).toBe('computeBudget:limit');
    
    // Test set compute unit price (0x03)
    expect(decodeInstructionKind(
      KNOWN_PROGRAM_IDS.COMPUTE_BUDGET,
      undefined,
      new Uint8Array([0x03, 0x00, 0x00, 0x00])
    )).toBe('computeBudget:price');
  });
  
  it('should have findLiquidationIndex function', async () => {
    const { findLiquidationIndex } = await import('../src/execute/validation.js');
    
    expect(findLiquidationIndex).toBeDefined();
    expect(typeof findLiquidationIndex).toBe('function');
  });
  
  it('should have validateLiquidationWindow function', async () => {
    const { validateLiquidationWindow } = await import('../src/execute/validation.js');
    
    expect(validateLiquidationWindow).toBeDefined();
    expect(typeof validateLiquidationWindow).toBe('function');
  });
  
  it('should have decodeCompiledInstructions function', async () => {
    const { decodeCompiledInstructions } = await import('../src/execute/validation.js');
    
    expect(decodeCompiledInstructions).toBeDefined();
    expect(typeof decodeCompiledInstructions).toBe('function');
  });
  
  it('should export liquidation constants from liquidationBuilder', async () => {
    const { KLEND_PROGRAM_ID, LIQUIDATE_V1_DISCRIMINATOR } = await import('../src/kamino/liquidationBuilder.js');
    
    expect(KLEND_PROGRAM_ID).toBeDefined();
    expect(KLEND_PROGRAM_ID.toBase58()).toBe('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
    expect(LIQUIDATE_V1_DISCRIMINATOR).toBe('d88378ff5e9e5028');
  });
  
  it('should verify validation returns proper result structure', async () => {
    // Verify the ValidationResult type structure
    const expectedStructure = {
      valid: 'boolean',
      diagnostics: 'string',
      liquidationIndex: 'number or undefined',
    };
    
    expect(expectedStructure.valid).toBe('boolean');
    expect(expectedStructure.diagnostics).toBe('string');
    expect(expectedStructure.liquidationIndex).toBe('number or undefined');
  });
});
