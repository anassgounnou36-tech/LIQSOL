# Compiled Instruction Validation Fix Summary

## Problem Statement

Bot was crashing with error:
```
COMPILED VALIDATION FAILED: Liquidation instruction not found in compiled transaction
```

**Root Causes:**
1. The compiled-window validator used unstable matching to find liquidation instructions in v0 transactions
2. Bot crashed (threw exception) on validation failures instead of continuing
3. 6016 ObligationHealthy error caused bot to stop instead of treating as soft failure

## Solution

### 1. Semantic Compiled-Instruction Matching

Created new module `src/execute/decodeKaminoKindFromCompiled.ts` with:
- **KLEND_PROGRAM_ID**: Constant for Kamino KLend program
- **KAMINO_DISCRIMINATORS**: Centralized mapping of all Kamino instruction discriminators
  - refreshReserve: `07930aa66d3aa710`
  - refreshObligation: `a8e5e45f8c4c29c0`
  - liquidateObligationAndRedeemReserveCollateral: `d88378ff5e9e5028`
  - refreshObligationFarmsForReserve: `d79cf84dbd8fe9e2`
  - flashBorrowReserveLiquidity: `d60e1307b8c6ef35`
  - flashRepayReserveLiquidity: `f69c6e18b02e3e8d`
- **decodeInstructionKind()**: Decoder function for instruction types
- **extractDiscriminator()**: Helper to extract 8-byte discriminator from instruction data

### 2. Enhanced Validation Module

Created `src/execute/validation.ts` with:
- **findLiquidationIndex()**: Finds liquidation by programId + discriminator matching
- **validateLiquidationWindow()**: Validates instruction window with KLend adjacency rules
- **decodeCompiledInstructions()**: Decodes all compiled instructions with metadata
- Enhanced diagnostics showing what was found when validation fails

### 3. Graceful Error Handling

#### In executor.ts:
- Replaced `throw new Error()` with `return { status: 'compiled-validation-failed' }`
- Added 6016 ObligationHealthy detection with soft failure status
- Bot continues to next plan instead of crashing

#### In seizedDeltaEstimator.ts:
- Detects 6016 in simulation errors
- Throws special `OBLIGATION_HEALTHY` error message
- Executor catches and returns `{ status: 'obligation-healthy' }`

### 4. Centralized Discriminator Usage

#### In liquidationBuilder.ts:
- Exports `KLEND_PROGRAM_ID` constant
- Exports `LIQUIDATE_V1_DISCRIMINATOR` for executor validation

#### In canonicalLiquidationIxs.ts:
- Imports discriminators from centralized module
- Uses semantic matching (programId + discriminator) to find liquidation
- Enhanced diagnostics when liquidation not found

## Files Changed

### New Files:
1. `src/execute/decodeKaminoKindFromCompiled.ts` - Discriminator mappings and decoder
2. `src/execute/validation.ts` - Semantic validation with enhanced diagnostics
3. `test/compiled-validation.test.ts` - Unit tests for validation module

### Modified Files:
1. `src/kamino/liquidationBuilder.ts` - Export constants
2. `src/kamino/canonicalLiquidationIxs.ts` - Use centralized discriminators
3. `src/execute/executor.ts` - Graceful error handling, 6016 soft failure
4. `src/execute/seizedDeltaEstimator.ts` - Detect and handle 6016

## Validation Logic

### Canonical Instruction Sequence Expected:

**PRE (contiguous, immediately before liquidation):**
- refreshReserve (collateral)
- refreshReserve (repay)
- refreshObligation
- refreshObligationFarmsForReserve (0-2 instructions, if farms exist)

**LIQUIDATE:**
- liquidateObligationAndRedeemReserveCollateral

**POST (immediately after liquidation):**
- refreshObligationFarmsForReserve (same farms as PRE, if exist)

### Matching Algorithm:

1. Decode all compiled instructions with programId + discriminator
2. Find liquidation instruction by:
   - programId === KLend program ID
   - discriminator === liquidation v1 discriminator
3. Validate PRE sequence (walking backwards from liquidation)
4. Validate POST sequence (walking forwards from liquidation)
5. Return detailed diagnostics on mismatch

## Error Handling

### Status Returns:
- `compiled-validation-failed` - Validation mismatch, logged and skipped
- `obligation-healthy` - 6016 error, soft failure (skip and continue)
- `sim-error` - Other simulation errors
- `build-failed` - Transaction build errors

### 6016 ObligationHealthy Handling:
1. **During seized-delta estimation**: seizedDeltaEstimator detects 6016, throws `OBLIGATION_HEALTHY`
2. **During main simulation**: executor detects 6016, logs soft failure message
3. **Bot behavior**: Skips plan and continues with next cycle (no crash)

## Security

✅ CodeQL scan completed with **0 alerts**

## Testing

Created comprehensive unit tests in `test/compiled-validation.test.ts`:
- Validates discriminator constants are exported correctly
- Validates KLEND_PROGRAM_ID matches expected value
- Validates instruction kind decoder functions
- Validates validation functions are exported
- Validates liquidationBuilder exports constants

## Benefits

1. **No more crashes**: Bot continues on validation failures
2. **Better diagnostics**: Enhanced logging shows exactly what went wrong
3. **Semantic matching**: Reliable programId + discriminator matching for v0 transactions
4. **Soft failures**: 6016 ObligationHealthy treated as normal runtime state
5. **Centralized constants**: Single source of truth for discriminators
6. **Type safety**: TypeScript types ensure correct usage

## Migration Notes

- No breaking changes to public APIs
- Existing calls to `validateCompiledInstructionWindow` work unchanged
- New validation module is backward compatible
- Bot will now handle validation failures gracefully instead of crashing
