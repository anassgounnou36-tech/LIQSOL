# PR Summary: Unify Liquidation Instruction Assembly and Validate Compiled Instruction Window

## Overview
This PR implements a canonical liquidation instruction builder and compiled instruction window validation to fix Custom(6051) IncorrectInstructionInPosition and Custom(6009) ReserveStale errors across all code paths.

## Problem Statement
The liquidation system was experiencing:
- **Custom(6051) IncorrectInstructionInPosition**: Occurred during liquidation in both seized-delta sim and broadcast due to incorrect instruction ordering in compiled transaction
- **Custom(6009) ReserveStale**: Occurred at RefreshObligation when pre-refresh instructions were missing or not adjacent

**Root Cause**: Different builders/paths (broadcast tx, seized-delta sim, fallback liquidation-only) assembled slightly different instruction sequences, and label-based validation didn't reflect the final compiled transaction order.

## Solution

### 1. Single Canonical Source (`src/kamino/canonicalLiquidationIxs.ts`)
Created `buildKaminoRefreshAndLiquidateIxsCanonical()` that returns ONE canonical liquidation instruction list used by ALL paths.

**Canonical Order**:
```
1. computeBudget (limit + optional price)
2. flashBorrow (if using flashloan)
3. preRefreshReserve(repay)
4. preRefreshReserve(collateral)
5. refreshFarmsForObligationForReserve (collateral, if farm exists)
6. refreshObligation (with remaining accounts ordered deposits→borrows)
7. postRefreshReserve(repay)
8. postRefreshReserve(collateral)
9. liquidateObligationAndRedeemReserveCollateral
10. swap instructions (optional, only after liquidate)
11. flashRepay (if using flashloan)
```

### 2. Compiled Validation
Implemented `validateCompiledInstructionWindow()` to validate the actual compiled transaction:
- Decodes program IDs and instruction discriminators from compiled message
- Maps Kamino instruction discriminators to types (refreshReserve, refreshObligation, liquidate, etc.)
- Asserts that the 4-5 instructions immediately preceding liquidation are exactly:
  - [refreshFarmsForObligationForReserve (opt)], refreshObligation, RefreshReserve(repay), RefreshReserve(collateral)
- Logs 6-instruction window with decoded kinds for diagnostics
- Throws build-time error if validation fails

### 3. Unified Usage (`src/execute/executor.ts`)
Updated `buildFullTransaction()` to use canonical builder:
- **Broadcast path**: Uses canonical helper with flashloan
- **Seized-delta simulation**: Uses canonical helper WITHOUT flashloan (prevents 6032 NoFlashRepayFound)
- **Fallback liquidation-only**: Uses canonical helper without swap

All paths now produce identical pre/post refresh sequences.

## Key Files Changed

### New Files
- **`src/kamino/canonicalLiquidationIxs.ts`** (378 lines)
  - `buildKaminoRefreshAndLiquidateIxsCanonical()`
  - `decodeCompiledInstructionKinds()`
  - `validateCompiledInstructionWindow()`

### Modified Files
- **`src/execute/executor.ts`**
  - Updated `buildFullTransaction()` to use canonical builder
  - Added compiled validation before simulation/broadcast
  - Logs decoded instruction kinds from compiled message

## Benefits

1. **Single Source of Truth**: All code paths use canonical builder
2. **Compiled Validation**: Validates actual compiled instruction window
3. **Tight Adjacency**: Pre-refresh and post-refresh sequences maintained
4. **Deterministic Assembly**: Consistent instruction order across runs
5. **Error Prevention**: Fails before broadcasting invalid transactions

## Testing Recommendations

Run liquidation simulation:
```bash
npm run executor:dry
```

Expected: Simulation passes without 6051 or 6009 errors

## Acceptance Criteria

All requirements from problem statement addressed:
- ✅ Single canonical source for all paths
- ✅ Compiled instruction window validation
- ✅ Instruction variants verified
- ✅ Tight adjacency maintained
- ✅ Build-time validation with clear diagnostics
