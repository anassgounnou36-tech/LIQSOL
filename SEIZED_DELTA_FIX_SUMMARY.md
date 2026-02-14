# Seized Delta Swap Sizing Fix - Implementation Summary

## Problem
The bot was reaching seized-delta sizing and failing with error 6032 (`NoFlashRepayFound`), blocking transaction build and causing the bot to skip liquidation plans.

### Issues Identified
1. Error 6032 was not decoded to a human-readable name
2. Seized-delta simulation was using the wrong collateral ATA for monitoring
3. **FlashBorrow/flashRepay in simulation caused error 6032 during seized-delta estimation**
4. No fallback behavior when sizing failed - bot would permanently skip plans
5. No instruction map printed on simulation failure for debugging
6. **No mutex to prevent overlapping executor ticks in live mode**

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

### 3. **[NEW] Removed FlashBorrow/FlashRepay from Seized-Delta Simulation** (`src/execute/executor.ts`)
**Problem**: Including flashBorrow/flashRepay in the simulation caused error 6032 (NoFlashRepayFound) because:
- Flash loan instructions require proper pairing
- Simulation doesn't execute the full transaction flow
- Error 6032 occurs when flash borrow has no corresponding repay

**Solution**:
- Build simulation transaction with **ONLY** liquidation path instructions:
  1. ComputeBudget instructions
  2. PRE-REFRESH: RefreshReserve (repay)
  3. PRE-REFRESH: RefreshReserve (collateral)
  4. RefreshFarmsForObligationForReserve (if farm exists)
  5. RefreshObligation (with ALL reserves)
  6. POST-REFRESH: RefreshReserve (repay)
  7. POST-REFRESH: RefreshReserve (collateral)
  8. LiquidateObligationAndRedeemReserveCollateral

- **Excludes**: flashBorrow and flashRepay
- This isolates the liquidation path for delta measurement
- Avoids flash loan pairing issues during simulation
- Simulation-specific labels for diagnostic output

### 4. Instruction Map on Failure (`src/execute/seizedDeltaEstimator.ts`)
- Added optional `instructionLabels` parameter to `EstimateSeizedCollateralDeltaParams`
- Print instruction map when simulation fails:
  ```
  [SeizedDelta] ═══ SIMULATION INSTRUCTION MAP ═══
    [0] computeBudget:limit
    [1] refreshReserve:repay:pre
    [2] refreshReserve:collateral:pre
    [3] refreshFarms
    [4] refreshObligation
    [5] refreshReserve:repay:post
    [6] refreshReserve:collateral:post
    [7] liquidate
  ═════════════════════════════════════════
  ```
- Pass simulation-specific labels from executor to estimator
- **Note**: No longer includes flashBorrow/flashRepay in simulation

### 5. Documentation of Expected Instruction Sequence
Updated `seizedDeltaEstimator.ts` doc comment to document the simulation instruction sequence:
- **Clarified**: Simulation should contain ONLY liquidation path (NO flashBorrow/flashRepay)
- Explained why: Avoids error 6032 during simulation
- Listed expected instruction order without flash loan instructions

### 6. **[NEW] Tick Mutex to Prevent Overlapping Runs** (`src/execute/executor.ts`)
**Problem**: In live mode, overlapping executor ticks could cause:
- Duplicate transaction builds
- Duplicate broadcasts
- Race conditions in state management

**Solution**:
- Added module-level `tickInProgress` boolean flag
- Guard at entry of `runDryExecutor`:
  ```typescript
  if (tickInProgress) {
    console.warn('[Executor] Tick skipped: previous tick still in progress');
    return { status: 'skipped-busy' };
  }
  tickInProgress = true;
  ```
- Wrapped entire function body in try-finally block
- Finally block always resets `tickInProgress = false`
- Logs clear warning when tick is skipped
- Returns `{ status: 'skipped-busy' }` for monitoring

### 7. Fallback Behavior (`src/execute/executor.ts`)
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
1. `src/execute/seizedDeltaEstimator.ts` - Add instruction map, fix ATA monitoring logs, update doc comments
2. `src/kamino/liquidationBuilder.ts` - Return withdrawCollateralMint
3. `src/execute/executor.ts` - **[UPDATED]** Remove flashBorrow/flashRepay from simulation, decode 6032, use withdrawCollateralMint, add fallback, add tick mutex
4. `.env.example` - Add SWAP_SIZING_FALLBACK_ENABLED configuration
5. `SEIZED_DELTA_FIX_SUMMARY.md` - **[UPDATED]** Document all changes including simulation fix and tick mutex

## Key Implementation Details

### Seized-Delta Simulation Without Flash Loan
```typescript
// Build simulation with ONLY liquidation path (NO flashBorrow/flashRepay)
const simIxs = [
  ...computeIxs,                        // ComputeBudget
  ...liquidationResult.refreshIxs,      // PRE refresh + farms + obligation + POST refresh
  ...liquidationResult.liquidationIxs,  // Liquidate
];

// Corresponding labels for diagnostics
const simLabels = [
  'computeBudget:limit',
  ...(computeIxs.length > 1 ? ['computeBudget:price'] : []),
  'refreshReserve:repay:pre',
  'refreshReserve:collateral:pre',
  ...(hasFarmsRefresh ? ['refreshFarms'] : []),
  'refreshObligation',
  'refreshReserve:repay:post',
  'refreshReserve:collateral:post',
  'liquidate',
];
```

### Tick Mutex Implementation
```typescript
// Module-level flag
let tickInProgress = false;

export async function runDryExecutor(opts?: ExecutorOpts) {
  if (tickInProgress) {
    console.warn('[Executor] Tick skipped: previous tick still in progress');
    return { status: 'skipped-busy' };
  }
  
  tickInProgress = true;
  try {
    // ... executor logic ...
  } finally {
    tickInProgress = false;
  }
}
```

## Testing
The changes are backward-compatible:
- `instructionLabels` parameter is optional (no breaking change)
- `withdrawCollateralMint` is added to result (additive change)
- Fallback is enabled by default but can be disabled
- Error decoding only adds more information (no behavior change)
- Tick mutex prevents overlapping runs (new safety feature)
- Simulation no longer includes flashBorrow/flashRepay (avoids error 6032)

## Expected Behavior After Fix
1. ✅ Error 6032 shows as "NoFlashRepayFound" with diagnostic guidance
2. ✅ Seized-delta estimation monitors correct collateral ATA (user_destination_collateral)
3. ✅ **[NEW]** Seized-delta simulation excludes flashBorrow/flashRepay (no more error 6032 in simulation)
4. ✅ Failed simulations print instruction map for debugging (without flash loan instructions)
5. ✅ When sizing fails, bot proceeds with liquidation-only (fallback mode)
6. ✅ Bot continues 24/7 operation instead of permanently skipping plans
7. ✅ Logs clearly distinguish liquidity mint vs redemption mint
8. ✅ **[NEW]** Overlapping executor ticks are prevented (returns 'skipped-busy')

## Edge Cases Handled
- **ATAs missing**: Setup transaction sent first, sizing runs in next cycle (existing behavior)
- **Sizing fails**: Fallback to liquidation-only (new behavior)
- **Simulation error 6032**: No longer occurs in seized-delta simulation; if occurs elsewhere, decoded with clear guidance
- **No instruction labels**: Instruction map section gracefully skipped
- **Overlapping ticks**: Subsequent ticks skipped with clear log message until previous tick completes
