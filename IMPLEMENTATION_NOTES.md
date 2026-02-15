# Unified Liquidation Instruction Assembly - Implementation Summary

## Problem Addressed

This PR fixes Custom(6051) IncorrectInstructionInPosition and Custom(6009) ReserveStale errors by:
1. Creating a single canonical source for liquidation instruction assembly
2. Implementing compiled instruction window validation
3. Unifying usage across all code paths (broadcast, seized-delta sim, fallback)

## Key Changes

### 1. Canonical Instruction Builder (`src/kamino/canonicalLiquidationIxs.ts`)

**New File**: Implements the single source of truth for liquidation instruction assembly.

#### `buildKaminoRefreshAndLiquidateIxsCanonical()`
Builds canonical liquidation sequence used by ALL paths:

**Canonical Order (with flashloan)**:
1. computeBudget (limit + optional price)
2. flashBorrow (optional)
3. preRefreshReserve(repay)
4. preRefreshReserve(collateral)
5. refreshFarmsForObligationForReserve (optional, if farm exists)
6. refreshObligation (with remaining accounts ordered deposits→borrows)
7. postRefreshReserve(repay)
8. postRefreshReserve(collateral)
9. liquidateObligationAndRedeemReserveCollateral
10. swap instructions (optional, after liquidate)
11. flashRepay (optional)

**Key Features**:
- Single configuration interface for all parameters
- Consistent instruction sequence regardless of code path
- Proper handling of optional instructions (farms, flashloan, swap)
- Returns both instructions and labels for validation

#### `decodeCompiledInstructionKinds()`
Decodes instruction kinds from compiled transaction message:
- Extracts program IDs and discriminators (first 8 bytes of data)
- Maps Kamino instruction discriminators to human-readable names:
  - `0x07930aa66d3aa710` → refreshReserve
  - `0xa8e5e45f8c4c29c0` → refreshObligation
  - `0xd88378ff5e9e5028` → liquidateObligationAndRedeemReserveCollateral
  - `0xd79cf84dbd8fe9e2` → refreshObligationFarmsForReserve
  - `0xd60e1307b8c6ef35` → flashBorrowReserveLiquidity
  - `0xf69c6e18b02e3e8d` → flashRepayReserveLiquidity
- Also identifies ComputeBudget, Jupiter, Token, and ATA program instructions

#### `validateCompiledInstructionWindow()`
Validates compiled transaction instruction window:
- Verifies 4-5 instruction sequence before liquidation matches expected canonical order
- Expected window: [refreshFarms (opt)], refreshObligation, refreshReserve(repay), refreshReserve(collateral), liquidate
- Returns validation result with detailed diagnostics
- **Build-time validation** prevents broadcasting invalid transactions

#### `buildAndValidateCanonicalLiquidationTx()`
Helper that combines building and validation:
1. Builds canonical instruction sequence
2. Compiles to VersionedTransaction
3. Validates compiled instruction window
4. Returns signed transaction with validation diagnostics

### 2. Unified Executor (`src/execute/executor.ts`)

**Updated `buildFullTransaction()`**:
- Now uses `buildKaminoRefreshAndLiquidateIxsCanonical()` instead of manual assembly
- Three-step process:
  1. Build initial canonical sequence (without swap)
  2. Run seized-delta estimation if swap needed (using canonical builder for simulation)
  3. Build final canonical sequence with swap (if generated)

**Key Improvements**:
- **Unified simulation path**: Seized-delta estimation now uses canonical builder (without flashloan)
- **Consistent instruction assembly**: All paths use same canonical helper
- **Metadata propagation**: Returns `hasFarmsRefresh` for validation

**Updated `runDryExecutor()`**:
- Added compiled instruction window validation before simulation/broadcast
- Validates compiled transaction using `validateCompiledInstructionWindow()`
- Logs decoded instruction kinds from compiled message
- **Fails fast** if validation fails, preventing invalid transactions from being broadcast

### 3. Validation Points

#### Build-Time Validation (Executor)
```typescript
const validation = validateCompiledInstructionWindow(tx, labels, metadata.hasFarmsRefresh);

if (!validation.valid) {
  console.error('[Executor] ❌ COMPILED VALIDATION FAILED:');
  console.error(validation.diagnostics);
  throw new Error('Compiled instruction window validation failed');
}
```

#### Decoded Instruction Logging
```typescript
const compiledKinds = decodeCompiledInstructionKinds(tx);
console.log('\n[Executor] ═══ COMPILED INSTRUCTION KINDS ═══');
compiledKinds.forEach((kind, idx) => {
  const labelMatch = labels[idx] ? ` (label: ${labels[idx]})` : '';
  console.log(`  [${idx}] ${kind.kind}${labelMatch}`);
});
```

## Benefits

1. **Single Source of Truth**: All code paths use `buildKaminoRefreshAndLiquidateIxsCanonical()`
   - Broadcast transaction: uses canonical helper with flashloan
   - Seized-delta simulation: uses canonical helper without flashloan
   - Fallback liquidation-only: uses canonical helper

2. **Compiled Validation**: Validates actual compiled instruction window, not just labels
   - Catches divergence between labels and compiled message
   - Decodes program IDs and discriminators
   - Verifies exact sequence expected by KLend

3. **Tight Adjacency**: Pre-refresh and post-refresh sequences maintained
   - Pre-refresh (repay + collateral) immediately before refreshObligation
   - Post-refresh (repay + collateral) immediately before liquidation
   - No instructions inserted between critical sequences

4. **Deterministic Assembly**: Consistent instruction order across runs
   - No conditional branching that varies instruction positions
   - Farms refresh correctly inserted when present
   - Swap instructions always after liquidation

5. **Build-Time Error Prevention**: Fails before broadcasting invalid transactions
   - Prevents 6051 (IncorrectInstructionInPosition)
   - Prevents 6009 (ReserveStale)
   - Clear diagnostic output for troubleshooting

## Testing

The canonical builder ensures:
1. Instruction count always matches label count
2. Canonical ordering preserved: flashBorrow < preRefresh < refreshObligation < postRefresh < liquidate < swap < flashRepay
3. Liquidation always follows post-refresh instructions
4. Compiled instruction kinds match expected discriminators
5. 4-5 instruction window before liquidation matches canonical sequence

## Migration Path

Existing code continues to work:
- `buildKaminoLiquidationIxs()` in `liquidationBuilder.ts` unchanged
- Executor uses new canonical builder for transaction assembly
- Setup instructions still handled separately
- Swap sizing logic unchanged (uses canonical builder for simulation)

## Future Enhancements

1. Add reserve pubkey validation in compiled window
   - Verify postRefresh instructions reference correct reserve pubkeys
   - Match against plan's expectedRepayReservePubkey and expectedCollateralReservePubkey

2. Extend validation to verify remaining accounts in refreshObligation
   - Decode remaining accounts from compiled instruction
   - Verify deposits→borrows ordering

3. Add compiled validation to other transaction builders
   - Apply same validation pattern to setup transactions
   - Validate swap instruction sequences
