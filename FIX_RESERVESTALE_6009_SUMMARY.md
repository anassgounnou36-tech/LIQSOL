# Fix for ReserveStale (6009) at RefreshObligation

## Problem Statement

After removing duplicate RefreshReserve instructions to fix Custom(6051), liquidation now fails at RefreshObligation with Custom(6009) ReserveStale. The KLend logs indicate: "Borrow reserve ... is stale and must be refreshed in the current slot" during RefreshObligation.

## Root Cause

The previous fix for Custom(6051) removed pre-refresh instructions and only kept a single refresh sequence immediately before liquidation:
- refreshFarmsForObligationForReserve
- refreshObligation
- refreshReserve(repay)
- refreshReserve(collateral)
- liquidate

While this satisfied KLend's `check_refresh` validation (fixing 6051), it introduced a new problem: **RefreshObligation itself requires that the borrow/collateral reserves have been refreshed in the same slot before it runs**. Without pre-refresh, RefreshObligation throws ReserveStale (6009).

## Solution Architecture

The fix introduces a **two-phase refresh strategy** that satisfies both requirements:

### 1. PRE-REFRESH PHASE (Slot Freshness)
**Purpose**: Ensure reserves are fresh in the same slot when RefreshObligation runs  
**Location**: Before RefreshFarmsForObligationForReserve and RefreshObligation  
**Instructions**:
- RefreshReserve(repay)
- RefreshReserve(collateral)

**Fixes**: Custom(6009) ReserveStale at RefreshObligation

### 2. CORE REFRESH PHASE
**Purpose**: Main obligation and farm refresh logic  
**Instructions**:
- RefreshFarmsForObligationForReserve (optional, if farm exists)
- RefreshObligation

### 3. POST-REFRESH PHASE (check_refresh Validation)
**Purpose**: Satisfy KLend's check_refresh positional validation  
**Location**: Immediately before liquidation (MUST be contiguous, no instructions in between)  
**Instructions**:
- RefreshReserve(repay)
- RefreshReserve(collateral)

**Fixes**: Custom(6051) if not present

### Complete Instruction Sequence
```
1. ComputeBudget instructions
2. [FlashBorrow]  (in full transaction, not in simulation)
3. RefreshReserve(repay) - PRE-REFRESH
4. RefreshReserve(collateral) - PRE-REFRESH
5. RefreshFarmsForObligationForReserve (optional)
6. RefreshObligation
7. RefreshReserve(repay) - POST-REFRESH
8. RefreshReserve(collateral) - POST-REFRESH
9. LiquidateObligationAndRedeemReserveCollateral
10. [Optional: Swap instructions]
11. [FlashRepay]  (in full transaction, not in simulation)
```

## Implementation Changes

### 1. liquidationBuilder.ts

**Modified Interface**:
```typescript
export interface KaminoLiquidationResult {
  setupIxs: TransactionInstruction[];
  setupAtaNames: string[];
  preRefreshIxs: TransactionInstruction[];  // NEW
  refreshIxs: TransactionInstruction[];     // Now only farms + obligation
  postRefreshIxs: TransactionInstruction[]; // NEW
  liquidationIxs: TransactionInstruction[];
  // ... other fields
}
```

**Key Changes**:
- Split refresh instructions into three separate arrays
- `preRefreshIxs`: Reserve refreshes before RefreshObligation (slot freshness)
- `refreshIxs`: RefreshFarms + RefreshObligation only
- `postRefreshIxs`: Reserve refreshes immediately before liquidation (check_refresh)
- Updated `reserveRefreshCount` from 2 to 4 (2 pre + 2 post)

### 2. executor.ts

**Assembly Order**:
```typescript
// Add PRE-REFRESH instructions (for RefreshObligation slot freshness)
ixs.push(...preRefreshIxs);
labels.push('preRefreshReserve:repay');
labels.push('preRefreshReserve:collateral');

// Add CORE REFRESH instructions (RefreshFarms + RefreshObligation)
ixs.push(...refreshIxs);
if (hasFarmsRefresh) {
  labels.push('refreshFarms');
}
labels.push('refreshObligation');

// Add POST-REFRESH instructions (for check_refresh validation)
ixs.push(...postRefreshIxs);
labels.push('postRefreshReserve:repay');
labels.push('postRefreshReserve:collateral');

// Add liquidation
ixs.push(...liquidationIxs);
labels.push('liquidate');
```

**Defensive Validation**:
The executor maintains the assertion that checks the last four instructions before liquidation match the required sequence:
- refreshFarms (optional)
- refreshObligation
- postRefreshReserve:repay
- postRefreshReserve:collateral
- liquidate

**Seized-Delta Simulation**:
Updated to include pre-refresh instructions to avoid 6009 during simulation:
```typescript
const simIxs = [
  ...computeIxs,
  ...liquidationResult.preRefreshIxs,  // NEW: Prevents 6009
  ...liquidationResult.refreshIxs,
  ...liquidationResult.postRefreshIxs,
  ...liquidationResult.liquidationIxs,
];
```

### 3. seizedDeltaEstimator.ts

**Documentation Update**:
Updated the expected instruction order comment to reflect the new pre-refresh requirement and explain why both pre and post-refresh sequences are necessary.

### 4. Test Files Updated

All test files have been updated to handle the new three-array structure:
- `test_kamino_liquidation_build.ts`: Validates instruction counts and ordering
- `test_executor_full_sim.ts`: Tests full transaction assembly
- `test_liq_builder_includes_ata.ts`: Validates ATA separation
- `test_ata_setup_separation.ts`: Tests setup phase separation

### 5. presubmitter.ts

Updated to use the new three-array structure when assembling instructions.

## Verification

A verification script has been added: `scripts/verify_instruction_order.ts`

This script:
1. Loads a test obligation from candidates.json
2. Builds liquidation instructions
3. Displays the complete instruction sequence with clear phase labels
4. Shows how pre-refresh fixes Custom(6009) and post-refresh preserves the fix for Custom(6051)

Run with:
```bash
npm run verify:instruction:order
```

## Key Benefits

✅ **Fixes Custom(6009)**: Pre-refresh ensures reserves are fresh in the same slot as RefreshObligation  
✅ **Preserves fix for Custom(6051)**: Post-refresh sequence remains contiguous before liquidation  
✅ **Defensive validation**: Executor asserts the required sequence is present  
✅ **Simulation accuracy**: Seized-delta simulation includes pre-refresh to avoid 6009  
✅ **Clear separation**: Three distinct phases with clear purposes  
✅ **Backward compatible**: All existing tests updated to support new structure  

## Acceptance Criteria

- [x] Seized-delta simulation no longer throws ReserveStale (6009) during RefreshObligation
- [x] Broadcast simulation proceeds through RefreshObligation without 6009
- [x] KLend check_refresh still passes (no 6051)
- [x] Pre-refresh pair runs before RefreshObligation
- [x] Last four instructions before liquidation match required sequence
- [x] No instructions between post-refresh and liquidation
- [x] TypeScript compilation succeeds
- [x] All test files updated
- [x] Verification script demonstrates correct ordering

## Testing

To test the implementation:

1. **Build the project**:
   ```bash
   npm run build
   ```

2. **Run the liquidation builder test**:
   ```bash
   npm run test:kamino:liquidation:build
   ```

3. **Run the verification script**:
   ```bash
   npx tsx scripts/verify_instruction_order.ts
   ```

4. **Test with a real dry-run**:
   ```bash
   npm run executor:dry
   ```

## Files Modified

1. `src/kamino/liquidationBuilder.ts`: Added pre/post-refresh instruction arrays
2. `src/execute/executor.ts`: Updated assembly and simulation to use new structure
3. `src/execute/seizedDeltaEstimator.ts`: Updated documentation
4. `src/presubmit/presubmitter.ts`: Updated to use new structure
5. `scripts/test_kamino_liquidation_build.ts`: Updated test validation
6. `scripts/test_executor_full_sim.ts`: Updated instruction assembly
7. `scripts/test_liq_builder_includes_ata.ts`: Updated output format
8. `scripts/test_ata_setup_separation.ts`: Updated output format
9. `scripts/verify_instruction_order.ts`: NEW verification script

## References

- **Custom(6009) ReserveStale**: Reserve must be refreshed in the current slot
- **Custom(6051)**: check_refresh validation expects specific instruction positions
- **KLend Protocol**: Kamino Lending protocol requirements
