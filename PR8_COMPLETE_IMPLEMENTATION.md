# PR8 Implementation Complete

## Summary

Successfully implemented PR8 critical fix to align validation and candidate metrics with PR7 health math. The issue was that validation independently recomputed collateral values using collateral mints (which have no oracle), causing contradictory results.

## Problem Statement

PR8 was producing contradictory results:
- **Candidate tables**: Showed obligations near liquidation (HR ≈ 1.0)
- **Validation samples**: Showed absurd values (HR > 600k, collateral in millions of SOL)

**Root Cause**: Validation attempted its own collateral shares → underlying conversion and price lookup using collateral mints (which have no oracle), diverging from PR7's health computation.

## Solution

### 1. Extended `computeHealthRatio()` (src/math/health.ts)

Added optional breakdown functionality to return detailed per-leg information:

```typescript
// New types
export interface HealthLegDeposit {
  reservePubkey: string;
  collateralMint: string;
  liquidityMint: string;
  collateralSharesUi: number;
  underlyingUi: number;
  priceUsd: number;
  usdRaw: number;
  usdWeighted: number;
}

export interface HealthLegBorrow {
  reservePubkey: string;
  liquidityMint: string;
  borrowUi: number;
  priceUsd: number;
  usdRaw: number;
  usdWeighted: number;
}

// Options
export interface HealthRatioOptions {
  includeBreakdown?: boolean;
  exposeRawHr?: boolean;
}
```

**Key Implementation Details**:
- When `includeBreakdown: true`, collects per-leg details during computation
- When `exposeRawHr: true`, exposes unclamped HR as `healthRatioRaw` for debugging
- Uses PR7-correct logic: collateral shares → underlying via mul-div and exchange rate
- Prices deposits using `reserve.liquidityMint` (underlying), NOT collateral mints
- Returns both raw and weighted totals for all calculations

### 2. Refactored `explainHealth()` (src/math/healthBreakdown.ts)

**Before**: Independent computation with separate collateral conversion logic
**After**: Thin wrapper that calls `computeHealthRatio(includeBreakdown: true, exposeRawHr: true)`

```typescript
export function explainHealth(
  obligation: DecodedObligation,
  reserveCache: ReserveCache,
  oracleCache: OracleCache
): HealthBreakdown {
  // Use computeHealthRatio with breakdown enabled to ensure identical computation
  const result = computeHealthRatio({
    deposits: obligation.deposits,
    borrows: obligation.borrows,
    reserves: reserveCache.byMint,
    prices: oracleCache,
    options: {
      includeBreakdown: true,
      exposeRawHr: true,
    },
  });
  
  // Map to legacy format and return
  // ...
}
```

**Critical Fix**: No more independent collateral conversion or price lookups!

### 3. Updated `snapshotCandidates.ts`

Enhanced validation output to:
- Show unclamped HR alongside clamped HR
- Display comparison with candidate table values
- Print candidate counts from selected candidates (not bootstrap stats)

```typescript
console.log("\nTotals:");
console.log(`  Health Ratio: ${breakdown.totals.healthRatio.toFixed(4)}`);
if (breakdown.totals.healthRatioRaw !== undefined) {
  console.log(`  Health Ratio (unclamped): ${breakdown.totals.healthRatioRaw.toFixed(4)}`);
}

console.log("\n  Candidate table values (for comparison):");
console.log(`    Borrow Value: $${c.borrowValueUsd.toFixed(2)}`);
console.log(`    Collateral Value: $${c.collateralValueUsd.toFixed(2)}`);
console.log(`    Health Ratio: ${c.healthRatio.toFixed(4)}`);
```

### 4. Verified `candidateSelector.ts`

Confirmed that:
- No independent recomputation of health values
- Uses `borrowValueUsd`, `collateralValueUsd`, and `healthRatio` from scoring
- Ranking formula correct: `priorityScore = urgency * size`

## Test Coverage

### New Tests

**health-breakdown.test.ts** (4 tests):
- Test breakdown included when option enabled
- Test breakdown excluded when option disabled
- Test explainHealth matches computeHealthRatio
- Test unclamped HR exposure

**pr8-alignment.test.ts** (4 comprehensive integration tests):
1. **Validation totals match scoring totals exactly**
   - Verifies all three computation paths (scoring, selection, validation) produce identical results
   
2. **Deposit pricing uses underlying liquidity mint not collateral mint**
   - Confirms oracle lookup uses `reserve.liquidityMint`, not `deposit.mint`
   - Tests that computation succeeds even without collateral mint oracle
   
3. **Validation breakdown shows realistic values not millions of SOL**
   - Verifies amounts and USD values are in expected ranges
   - Ensures no absurd multiplication/division errors
   
4. **Unclamped HR is exposed for debugging**
   - Tests that very high HR is clamped to 2.0 for ranking
   - Verifies raw unclamped value is still accessible for debugging

### Test Results

```
✓ src/__tests__/health-breakdown.test.ts (4 tests) 10ms
✓ src/__tests__/health-ratio.test.ts (9 tests) 22ms
✓ src/__tests__/pr8-alignment.test.ts (4 tests) 10ms

Test Files  20 passed (20)
Tests  140 passed | 2 skipped | 4 todo (146)
```

## Code Quality

### Code Review
- 5 issues identified and resolved
- Fixed division by zero in threshold/factor calculation
- Improved placeholder values for legacy compatibility

### Security Scan
- CodeQL security scan: **0 alerts found**
- No security vulnerabilities introduced

## Acceptance Criteria ✅

All acceptance criteria from the problem statement met:

✅ **Running snapshot command prints validation samples whose totals match candidate table**
   - Validated via comprehensive integration tests
   - Deposits, borrows, and totals all align within rounding

✅ **Validation deposit legs show realistic numbers**
   - `collateralSharesUi` and `underlyingUi` with realistic values
   - No more millions of SOL for tiny USD totals

✅ **No price lookups using collateral mints**
   - All deposit pricing uses underlying liquidity mint/price
   - Verified via test that succeeds without collateral mint oracle

✅ **Candidate ranking and table values sourced from same HealthComputeResult**
   - Verified via code inspection and integration tests
   - Single source of truth for all health computations

## Files Changed

1. `src/math/health.ts` - Extended with breakdown and options
2. `src/math/healthBreakdown.ts` - Refactored to use computeHealthRatio
3. `src/commands/snapshotCandidates.ts` - Enhanced validation output
4. `src/__tests__/health-breakdown.test.ts` - New test file
5. `src/__tests__/pr8-alignment.test.ts` - New integration test file

## Migration Notes

### Breaking Changes
None - all changes are backward compatible. Existing code continues to work without modifications.

### Optional Enhancements
To leverage the new breakdown feature:

```typescript
// Get detailed breakdown
const result = computeHealthRatio({
  deposits,
  borrows,
  reserves,
  prices,
  options: {
    includeBreakdown: true,
    exposeRawHr: true,
  },
});

if (result.scored && result.breakdown) {
  // Access per-leg details
  result.breakdown.deposits.forEach(d => {
    console.log(`Deposit: ${d.underlyingUi} ${d.liquidityMint} @ $${d.priceUsd}`);
  });
  
  // Access unclamped HR for debugging
  if (result.healthRatioRaw && result.healthRatioRaw !== result.healthRatio) {
    console.log(`HR clamped from ${result.healthRatioRaw} to ${result.healthRatio}`);
  }
}
```

## Conclusion

PR8 critical fix successfully implemented and tested. The validation and candidate metrics now align perfectly with PR7 health math, eliminating the contradictory results that made candidate selection unreliable.

**Key Achievement**: Single source of truth for all health computations ensures consistency across scoring, selection, and validation.
