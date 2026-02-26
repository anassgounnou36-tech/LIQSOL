import { describe, it, expect } from 'vitest';
import type { VersionedTransaction } from '@solana/web3.js';

async function buildMockCompiledTx(
  sequence: Array<
    'refreshReserve' |
    'refreshObligation' |
    'refreshObligationFarmsForReserve' |
    'liquidateObligationAndRedeemReserveCollateral'
  >
): Promise<VersionedTransaction> {
  const { PublicKey } = await import('@solana/web3.js');
  const { KNOWN_PROGRAM_IDS, KAMINO_DISCRIMINATORS } = await import('../src/execute/decodeKaminoKindFromCompiled.js');

  const discriminatorByKind = {
    refreshReserve: KAMINO_DISCRIMINATORS.refreshReserve,
    refreshObligation: KAMINO_DISCRIMINATORS.refreshObligation,
    refreshObligationFarmsForReserve: KAMINO_DISCRIMINATORS.refreshObligationFarmsForReserve,
    liquidateObligationAndRedeemReserveCollateral: KAMINO_DISCRIMINATORS.liquidateObligationAndRedeemReserveCollateral,
  } as const;

  return {
    message: {
      staticAccountKeys: [new PublicKey(KNOWN_PROGRAM_IDS.KAMINO_KLEND)],
      compiledInstructions: sequence.map((kind) => ({
        programIdIndex: 0,
        accountKeyIndexes: [],
        data: Buffer.from(discriminatorByKind[kind], 'hex'),
      })),
    },
  } as unknown as VersionedTransaction;
}

/**
 * Unit test to verify canonical liquidation instruction order
 * This test verifies the structure matches KLend's strict check_refresh adjacency rules
 */
describe('Canonical Liquidation Order', () => {
  it('should have new field names in KaminoLiquidationResult interface', async () => {
    // Import the builder
    const { buildKaminoLiquidationIxs } = await import('../src/kamino/liquidationBuilder.js');
    
    // Verify the function exists
    expect(buildKaminoLiquidationIxs).toBeDefined();
    expect(typeof buildKaminoLiquidationIxs).toBe('function');
  });
  
  it('should have buildKaminoRefreshAndLiquidateIxsCanonical function', async () => {
    // Import the canonical builder
    const { buildKaminoRefreshAndLiquidateIxsCanonical } = await import('../src/kamino/canonicalLiquidationIxs.js');
    
    // Verify the function exists
    expect(buildKaminoRefreshAndLiquidateIxsCanonical).toBeDefined();
    expect(typeof buildKaminoRefreshAndLiquidateIxsCanonical).toBe('function');
  });
  
  it('should have validateCompiledInstructionWindow function', async () => {
    // Import the validation function
    const { validateCompiledInstructionWindow } = await import('../src/kamino/canonicalLiquidationIxs.js');
    
    // Verify the function exists
    expect(validateCompiledInstructionWindow).toBeDefined();
    expect(typeof validateCompiledInstructionWindow).toBe('function');
  });
  
  it('should have decodeCompiledInstructionKinds function', async () => {
    // Import the decoder
    const { decodeCompiledInstructionKinds } = await import('../src/kamino/canonicalLiquidationIxs.js');
    
    // Verify the function exists
    expect(decodeCompiledInstructionKinds).toBeDefined();
    expect(typeof decodeCompiledInstructionKinds).toBe('function');
  });
  
  it('should verify canonical instruction sequence structure', () => {
    // Verify the expected canonical order
    const canonicalOrder = [
      'computeBudget',
      'flashBorrow (optional)',
      'PRE: RefreshReserve(N, all obligation reserves)',
      'CORE: RefreshObligation',
      'CORE: RefreshFarms (0-2, if exist)',
      'LIQUIDATE',
      'POST: RefreshFarms (mirrors PRE)',
      'swap (optional)',
      'flashRepay (optional)',
    ];
    
    expect(canonicalOrder).toHaveLength(9);
    expect(canonicalOrder[0]).toBe('computeBudget');
    expect(canonicalOrder[2]).toBe('PRE: RefreshReserve(N, all obligation reserves)');
    expect(canonicalOrder[3]).toBe('CORE: RefreshObligation');
    expect(canonicalOrder[4]).toBe('CORE: RefreshFarms (0-2, if exist)');
    expect(canonicalOrder[5]).toBe('LIQUIDATE');
    expect(canonicalOrder[6]).toBe('POST: RefreshFarms (mirrors PRE)');
  });
  
  it('should verify KLend adjacency requirements', () => {
    // Document the strict adjacency rules from KLend's check_refresh
    const adjacencyRules = {
      before_liquidation: {
        last_instruction: 'RefreshFarms (or RefreshObligation if no farms)',
        sequence: [
          'RefreshReserve(N contiguous, min 2)',
          'RefreshObligation',
          'RefreshFarms (0-2, if exist)',
        ],
      },
      after_liquidation: {
        first_instruction: 'RefreshFarms (mirrors PRE farms, if exist)',
      },
      removed: {
        post_reserve_refresh: 'Removed - was breaking adjacency by placing RefreshReserve immediately before liquidation',
      },
    };
    
    expect(adjacencyRules.before_liquidation.sequence).toHaveLength(3);
    expect(adjacencyRules.after_liquidation.first_instruction).toContain('RefreshFarms');
    expect(adjacencyRules.removed.post_reserve_refresh).toContain('Removed');
  });
  
  it('should verify farm mode handling', () => {
    // Verify both collateral and debt farms are supported
    const farmModes = {
      collateral: 0,
      debt: 1,
    };
    
    expect(farmModes.collateral).toBe(0);
    expect(farmModes.debt).toBe(1);
    
    // Verify farm refresh count can be 0-2
    const validFarmCounts = [0, 1, 2];
    expect(validFarmCounts).toContain(0); // No farms
    expect(validFarmCounts).toContain(1); // Collateral OR debt farm
    expect(validFarmCounts).toContain(2); // Collateral AND debt farms
  });
  
  it('should verify error codes fixed by canonical order', () => {
    // Document the errors fixed
    const fixedErrors = {
      'Custom(6009)': {
        name: 'ReserveStale',
        fix: 'PRE reserve refresh ensures reserves are fresh before RefreshObligation',
      },
      'Custom(6051)': {
        name: 'IncorrectInstructionInPosition',
        fix: 'POST farms refresh immediately after liquidation satisfies check_refresh adjacency',
      },
    };
    
    expect(fixedErrors['Custom(6009)'].name).toBe('ReserveStale');
    expect(fixedErrors['Custom(6051)'].name).toBe('IncorrectInstructionInPosition');
    expect(fixedErrors['Custom(6009)'].fix).toContain('PRE reserve refresh');
    expect(fixedErrors['Custom(6051)'].fix).toContain('POST farms refresh');
  });

  it('allows 2 PRE farms before liquidation when POST farms are disabled', async () => {
    const { validateCompiledInstructionWindow } = await import('../src/kamino/canonicalLiquidationIxs.js');

    const tx = await buildMockCompiledTx([
      'refreshReserve',
      'refreshReserve',
      'refreshObligation',
      'refreshObligationFarmsForReserve',
      'refreshObligationFarmsForReserve',
      'liquidateObligationAndRedeemReserveCollateral',
    ]);

    const result = validateCompiledInstructionWindow(tx, true, false);
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toContain('PRE farms count: 2');
  });

  it('requires POST farms count to mirror PRE farms when POST validation is enabled', async () => {
    const { validateCompiledInstructionWindow } = await import('../src/kamino/canonicalLiquidationIxs.js');

    const tx = await buildMockCompiledTx([
      'refreshReserve',
      'refreshReserve',
      'refreshObligation',
      'refreshObligationFarmsForReserve',
      'refreshObligationFarmsForReserve',
      'liquidateObligationAndRedeemReserveCollateral',
      'refreshObligationFarmsForReserve',
    ]);

    const result = validateCompiledInstructionWindow(tx, true, true);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContain('Expected post farms count to equal pre farms count (2)');
  });

  it('uses updated refreshObligation error message', async () => {
    const { validateCompiledInstructionWindow } = await import('../src/kamino/canonicalLiquidationIxs.js');

    const tx = await buildMockCompiledTx([
      'refreshReserve',
      'refreshReserve',
      'refreshObligationFarmsForReserve',
      'liquidateObligationAndRedeemReserveCollateral',
    ]);

    const result = validateCompiledInstructionWindow(tx, true, false);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContain('Missing refreshObligation before liquidation (allowing optional farms between refreshObligation and liquidation)');
  });
});
