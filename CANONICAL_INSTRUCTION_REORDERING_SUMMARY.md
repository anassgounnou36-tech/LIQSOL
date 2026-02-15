# Canonical Instruction Reordering Implementation Summary

## Problem Statement

KLend's liquidation handler performs strict instruction adjacency validation using the Instructions Sysvar. The program expects a specific sequence of refresh instructions immediately before and after liquidation. Failure to match this sequence results in **Custom(6051) IncorrectInstructionInPosition**.

Additionally, RefreshObligation requires reserves to be refreshed in the same slot, or it throws **Custom(6009) ReserveStale**.

## Solution Overview

This PR implements the canonical instruction sequence that satisfies both KLend validation requirements:

### Canonical Order

**PRE BLOCK** (contiguous, immediately before liquidation):
1. RefreshReserve(collateral/withdraw reserve)
2. RefreshReserve(repay/debt reserve)
3. RefreshObligation
4. RefreshFarmsForObligationForReserve (0-2 instructions for collateral mode=0 and/or debt mode=1, if farms exist)

**LIQUIDATE**:
5. LiquidateObligationAndRedeemReserveCollateral

**POST BLOCK** (immediately after liquidation):
6. RefreshFarmsForObligationForReserve (mirrors PRE farms, same set and order)

### Key Changes

1. **liquidationBuilder.ts**
   - Refactored return type from `preRefreshIxs/refreshIxs/postRefreshIxs` to `preReserveIxs/coreIxs/postFarmIxs`
   - **Removed POST reserve refresh instructions entirely** (they broke adjacency)
   - Added POST farms refresh that mirrors PRE farms
   - Supports both collateral (mode=0) and debt (mode=1) farms

2. **canonicalLiquidationIxs.ts**
   - Updated assembly order: computeBudget → flashBorrow → preReserveIxs → coreIxs → liquidationIxs → postFarmIxs → swap → flashRepay
   - Enhanced `validateCompiledInstructionWindow` to check both PRE and POST sequences
   - Validates 4 instructions before liquidation: [reserve(collateral), reserve(repay), obligation, farms]
   - Validates immediate instruction after liquidation is farms refresh

3. **seizedDeltaEstimator.ts**
   - Updated documentation to reflect canonical sequence

4. **presubmitter.ts**
   - Updated to use new field names: preReserveIxs, coreIxs, postFarmIxs

5. **swapSizing.ts**
   - Updated comments to reference canonical order

6. **Tests**
   - Created `canonical-liquidation-order.test.ts` to verify structure
   - Updated `test_kamino_liquidation_build.ts` for new field names
   - Documents farm mode handling and error codes fixed

## Files Changed

```
src/kamino/liquidationBuilder.ts
src/kamino/canonicalLiquidationIxs.ts
src/execute/seizedDeltaEstimator.ts
src/presubmit/presubmitter.ts
src/execute/swapSizing.ts
scripts/test_kamino_liquidation_build.ts
test/canonical-liquidation-order.test.ts (new)
```

## What's Fixed

- ✅ **Custom(6051) IncorrectInstructionInPosition** - POST farms immediately after liquidation satisfies check_refresh adjacency
- ✅ **Custom(6009) ReserveStale** - PRE reserve refresh ensures reserves are fresh before RefreshObligation
- ✅ Canonical order matches KLend's strict validation rules

## Security

- CodeQL analysis: **0 alerts** (no vulnerabilities found)
- All changes are structural refactoring with no new security implications
- Instruction order changes are required to match KLend's validation rules

## Farm Handling

The implementation now supports both farm types:
- **Collateral farms** (mode=0): Farms attached to collateral reserves
- **Debt farms** (mode=1): Farms attached to debt reserves
- Can have 0-2 farm instructions in PRE and POST blocks
- POST farms are IDENTICAL copies of PRE farms (same keys, programId, data)

## Validation Logic

The compiled instruction window validation ensures:

1. **PRE sequence** (immediately before liquidation):
   - Position -4: RefreshReserve(collateral)
   - Position -3: RefreshReserve(repay)
   - Position -2: RefreshObligation
   - Position -1: RefreshFarms (if farms exist)

2. **POST sequence** (immediately after liquidation):
   - Position +1: RefreshFarms (if farms exist, mirrors PRE)

## Testing

Run the test script to verify canonical structure:
```bash
npm run test:kamino:liquidation:build
```

Run unit tests:
```bash
npm test canonical-liquidation-order
```

## Migration Notes

If you have code that references the old field names, update as follows:

```typescript
// OLD
result.preRefreshIxs   // Reserve refreshes
result.refreshIxs      // Farms + Obligation
result.postRefreshIxs  // Reserve refreshes (REMOVED)

// NEW
result.preReserveIxs   // Reserve refreshes only
result.coreIxs         // Obligation + Farms
result.postFarmIxs     // Farms only (mirrors PRE)
```

## Future Work

- Monitor for any new KLend validation requirements
- Consider caching compiled farm instructions to avoid duplication
- Add integration tests with live obligations once environment is available

## References

- KLend program: `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`
- Kamino Farms program: `FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr`
- Error codes:
  - Custom(6051): IncorrectInstructionInPosition
  - Custom(6009): ReserveStale
