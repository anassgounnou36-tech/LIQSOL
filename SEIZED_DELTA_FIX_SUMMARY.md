# Seized Delta Swap Sizing Fix - Implementation Summary

## Problem
The bot was reaching seized-delta sizing and failing with error 6032 (`NoFlashRepayFound`), blocking transaction build and causing the bot to skip liquidation plans.

### Issues Identified
1. Error 6032 was not decoded to a human-readable name
2. Seized-delta simulation was using the wrong collateral ATA for monitoring
3. No fallback behavior when sizing failed - bot would permanently skip plans
4. No instruction map printed on simulation failure for debugging

## Solution Implemented

### 1. Error 6032 Decoding (`src/execute/executor.ts`)
- Added error 6032 to `knownErrors` mapping: `'NoFlashRepayFound - No corresponding repay found for flash borrow'`
- Added specific diagnostic guidance for error 6032:
  - Explains flash loan borrow/repay mismatch
  - Suggests checking FlashRepay instruction presence and position
  - Recommends using full instruction sequence for seized-delta simulation

### 2. Fixed Collateral ATA Tracking
**Problem**: Seized-delta estimator was monitoring the wrong ATA

**Root Cause**: 
- Liquidation builder returns `collateralMint` (liquidity mint from reserve)
- But liquidation redemption uses `withdrawCollateralMint` (from `collateralReserveState.collateral.mintPubkey`)
- These are different mints! The seized collateral goes to the `withdrawCollateralMint` ATA

**Fix** (`src/kamino/liquidationBuilder.ts`):
- Added `withdrawCollateralMint` field to `KaminoLiquidationResult` interface
- Return `withdrawCollateralMint` from liquidation builder
- Document distinction: `collateralMint` for swap, `withdrawCollateralMint` for seized-delta

**Fix** (`src/execute/executor.ts`):
- Extract `withdrawCollateralMint` from liquidation result
- Pass `withdrawCollateralMint` (not `collateralMint`) to seized-delta estimator
- Updated logging to show both mints for clarity

**Fix** (`src/execute/seizedDeltaEstimator.ts`):
- Updated logging to clarify monitoring `user_destination_collateral` ATA
- Added comment explaining this is NOT the withdrawLiq ATA

### 3. Instruction Map on Failure (`src/execute/seizedDeltaEstimator.ts`)
- Added optional `instructionLabels` parameter to `EstimateSeizedCollateralDeltaParams`
- Print instruction map when simulation fails:
  ```
  [SeizedDelta] ═══ SIMULATION INSTRUCTION MAP ═══
    [0] computeBudget:limit
    [1] flashBorrow
    [2] refreshReserve:repay:pre
    [3] refreshReserve:collateral:pre
    [4] refreshFarms
    [5] refreshObligation
    [6] refreshReserve:repay:post
    [7] refreshReserve:collateral:post
    [8] liquidate
  ═════════════════════════════════════════
  ```
- Pass labels from executor to estimator for diagnostic output

### 4. Documentation of Expected Instruction Sequence
Updated `seizedDeltaEstimator.ts` doc comment to document the COMPLETE required instruction sequence:
1. ComputeBudget instructions
2. FlashBorrow
3. PRE-REFRESH: RefreshReserve (repay)
4. PRE-REFRESH: RefreshReserve (collateral)
5. RefreshFarmsForObligationForReserve (if farm exists)
6. RefreshObligation (with ALL reserves)
7. POST-REFRESH: RefreshReserve (repay)
8. POST-REFRESH: RefreshReserve (collateral)
9. LiquidateObligationAndRedeemReserveCollateral

Note: "DO NOT use a shortened 'mini' liquidation sim - mirror the real sequence."

### 5. Fallback Behavior (`src/execute/executor.ts`)
**When seized-delta sizing fails:**

**Option A (default)** - Liquidation-only fallback:
- Log warning about sizing failure
- Skip swap instructions
- Proceed with liquidation-only transaction
- Seized collateral remains in destination ATA
- Bot continues with next cycle (24/7 operation)

**Option B** - Fail-fast mode:
- Throw error (original behavior)
- Skip plan entirely
- For testing/validation scenarios

**Configuration** (`.env.example`):
```bash
# Enable fallback to liquidation-only if swap sizing fails (default: true)
SWAP_SIZING_FALLBACK_ENABLED=true
```

## Files Changed
1. `src/execute/seizedDeltaEstimator.ts` - Add instruction map, fix ATA monitoring logs
2. `src/kamino/liquidationBuilder.ts` - Return withdrawCollateralMint
3. `src/execute/executor.ts` - Decode 6032, use withdrawCollateralMint, add fallback
4. `.env.example` - Add SWAP_SIZING_FALLBACK_ENABLED configuration

## Testing
The changes are backward-compatible:
- `instructionLabels` parameter is optional (no breaking change)
- `withdrawCollateralMint` is added to result (additive change)
- Fallback is enabled by default but can be disabled
- Error decoding only adds more information (no behavior change)

## Expected Behavior After Fix
1. ✅ Error 6032 shows as "NoFlashRepayFound" with diagnostic guidance
2. ✅ Seized-delta estimation monitors correct collateral ATA (user_destination_collateral)
3. ✅ Failed simulations print instruction map for debugging
4. ✅ When sizing fails, bot proceeds with liquidation-only (fallback mode)
5. ✅ Bot continues 24/7 operation instead of permanently skipping plans
6. ✅ Logs clearly distinguish liquidity mint vs redemption mint

## Edge Cases Handled
- **ATAs missing**: Setup transaction sent first, sizing runs in next cycle (existing behavior)
- **Sizing fails**: Fallback to liquidation-only (new behavior)
- **Simulation error 6032**: Now decoded with clear guidance
- **No instruction labels**: Instruction map section gracefully skipped
