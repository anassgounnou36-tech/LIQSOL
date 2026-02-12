# PR: Fix Candidate Enrichment to Always Output Reserve Pubkeys + Make Liquidation Builder Deterministic

## Summary

This PR fixes the candidate enrichment process to always output reserve pubkeys and makes the liquidation builder use deterministic reserve selection based on plan-provided reserve pubkeys.

## Problem

1. **Candidate enrichment used wrong cache index**: `snapshotCandidates.ts` was using `reserveCache.byMint.get(b.mint)` where `b.mint` could be a placeholder string like "unknown-mint-fetch-required", leading to missing or incorrect fields in candidates.

2. **Missing reserve pubkeys in tx_queue.json**: Plans frequently lacked `repayReservePubkey` and `collateralReservePubkey`, causing the executor to guess reserves and fail with Custom(6006) errors.

3. **Nondeterministic liquidation builder**: The liquidation builder used USD-based float math ranking to select reserves, which is nondeterministic and could mis-rank reserves.

4. **No validation**: No guardrails to ensure reserve pubkeys were populated or to drop incomplete plans.

## Changes Made

### 1. Fixed `src/commands/snapshotCandidates.ts` (CRITICAL)

**Before:**
```typescript
const usdcBorrow = borrows.find((b) => {
  const reserve = reserveCache.byMint.get(b.mint); // ❌ b.mint can be placeholder
  return reserve && reserve.liquidityMint === USDC_MINT;
});
```

**After:**
```typescript
// Extract reserve pubkeys from obligation borrows
const borrowReserves = borrows.map((b) => b.reserve);

// Lookup reserves using byReserve (not byMint which can have placeholder values)
const borrowEntries = borrowReserves.map((rpk) => ({
  reservePubkey: rpk,
  entry: reserveCache.byReserve.get(rpk) // ✅ Use reserve pubkey (stable)
}));

// Prefer USDC borrow if available
const usdcBorrow = borrowEntries.find((be) => be.entry && be.entry.liquidityMint === USDC_MINT);
const selectedBorrow = usdcBorrow ?? borrowEntries.find((be) => be.entry) ?? null;

if (selectedBorrow && selectedBorrow.entry) {
  repayReservePubkey = selectedBorrow.reservePubkey;
  primaryBorrowMint = selectedBorrow.entry.liquidityMint;
} else {
  // No cache entry found - still record reserve pubkey, log warning
  repayReservePubkey = borrowReserves[0];
  primaryBorrowMint = borrows[0].mint; // Use mint from obligation (may be placeholder)
  logger.warn({ obligationPubkey, repayReservePubkey }, "Repay reserve not found in cache");
}
```

**Key improvements:**
- Uses `reserveCache.byReserve.get(reservePubkey)` instead of `byMint.get(mint)`
- Always populates `repayReservePubkey` and `collateralReservePubkey` even if cache lookup fails
- Logs warnings for missing cache entries
- Applies same logic to both repay and collateral selection

**Added summary statistics:**
```typescript
console.log("=== RESERVE PUBKEY COVERAGE ===\n");
console.log(`Candidates with repayReservePubkey:      ${withRepayReserve}/${topN.length} (${pct}%)`);
console.log(`Candidates with collateralReservePubkey: ${withCollateralReserve}/${topN.length} (${pct}%)`);
console.log(`Candidates with BOTH reserve pubkeys:    ${withBothReserves}/${topN.length} (${pct}%)`);
```

### 2. Made `src/kamino/liquidationBuilder.ts` Deterministic

**Before:**
```typescript
// Select borrow with highest USD value
let maxBorrowValue = 0;
for (const borrow of borrows) {
  const borrowValue = (Number(borrowedAmountSf) / 1e18) * (price / Math.pow(10, decimals)); // ❌ Float math
  if (borrowValue > maxBorrowValue) {
    repayReserve = reserve;
  }
}
```

**After:**
```typescript
// PR: Prioritize expected reserve pubkey if provided (deterministic selection)
if (p.expectedRepayReservePubkey) {
  const expectedReservePubkey = p.expectedRepayReservePubkey.toBase58();
  console.log(`[LiqBuilder] Using deterministic repay reserve from plan: ${expectedReservePubkey}`);
  
  // Validate that obligation has a borrow leg for this reserve
  const borrowHasReserve = borrows.some((b: any) => b.borrowReserve.toString() === expectedReservePubkey);
  if (!borrowHasReserve) {
    throw new Error(`[LiqBuilder] preflight_reserve_mismatch: Expected repay reserve not found`);
  }
  
  // Load reserve directly from market
  repayReserve = market.getReserveByAddress(address(expectedReservePubkey));
} else {
  // Fallback: USD-based selection (float math - nondeterministic)
  console.log(`[LiqBuilder] Warning: Using USD-based reserve selection (nondeterministic)`);
  // ... existing float-based selection
}
```

**Key improvements:**
- Prioritizes `expectedRepayReservePubkey` and `expectedCollateralReservePubkey` from plan
- Validates that obligation has matching borrow/deposit legs before proceeding
- Moves USD-based float selection to fallback with warning
- Applies same logic to collateral reserve selection
- All SDK account params already use `address(...)` wrapper (verified)

### 3. Added Plan Validation in `scripts/test_scheduler_with_forecast.ts`

**Before:**
```typescript
const plans = filtered.map((c) => buildPlanFromCandidate(c, 'USDC'));
const queued = enqueuePlans(plans);
```

**After:**
```typescript
const plans = filtered.map((c) => buildPlanFromCandidate(c, 'USDC'));

// PR: Validate plans - drop those missing reserve pubkeys
const validPlans = [];
const droppedPlans = [];

for (const plan of plans) {
  const missingFields: string[] = [];
  if (!plan.repayReservePubkey) missingFields.push('repayReservePubkey');
  if (!plan.collateralReservePubkey) missingFields.push('collateralReservePubkey');
  
  if (missingFields.length > 0) {
    droppedPlans.push({ obligationPubkey: plan.obligationPubkey, reason: `Missing: ${missingFields.join(', ')}` });
  } else {
    validPlans.push(plan);
  }
}

// Report validation results
if (droppedPlans.length > 0) {
  console.log(`⚠️  Dropped ${droppedPlans.length} plan(s) due to missing reserve pubkeys`);
} else {
  console.log('✅ All plans have complete reserve pubkey information');
}

const queued = enqueuePlans(validPlans);
```

### 4. Verified `src/scheduler/txBuilder.ts` (No Changes Needed)

The `buildPlanFromCandidate` and `recomputePlanFields` functions already properly propagate:
- `repayReservePubkey` (line 83, 147)
- `collateralReservePubkey` (line 84, 148)
- `repayMint` / `collateralMint` (lines 79-80, 143-144)

## Testing Performed

### 1. Code Review
- ✅ Verified all changes compile without TypeScript errors
- ✅ Reviewed diffs to ensure correct implementation
- ✅ Confirmed no breaking changes to existing interfaces

### 2. Logic Verification
Created unit test file `test/verify_reserve_enrichment.test.ts` covering:
- ✅ Reserve lookup using `byReserve` instead of `byMint`
- ✅ Graceful handling of missing cache entries
- ✅ Deterministic reserve selection in liquidation builder
- ✅ Validation of expected reserves against obligation legs
- ✅ Plan validation to drop incomplete plans

### 3. Integration Testing (Recommended)
To fully validate these changes in a real environment:

```bash
# 1. Regenerate candidates with reserve pubkeys
npm run snapshot:candidates:wsl -- --top=50 --near=1.02 --validate-samples=5

# Expected: 
# - Console output shows "RESERVE PUBKEY COVERAGE" statistics
# - data/candidates.json entries include repayReservePubkey and collateralReservePubkey
# - Warnings logged for any missing cache entries

# 2. Regenerate tx_queue with validated plans
npm run test:scheduler:forecast:wsl

# Expected:
# - Console output shows plan validation results
# - data/tx_queue.json entries include repayReservePubkey and collateralReservePubkey
# - Plans missing reserve pubkeys are dropped with reasons logged

# 3. Dry-run liquidation
npm run executor:dry:wsl

# Expected:
# - Liquidation builder uses deterministic reserve selection
# - No more Custom(6006) errors from reserve mismatches
# - Meaningful errors only (ObligationHealthy, ObligationStale) or success
```

## Impact

### Positive Impact
1. **Reliability**: Candidate enrichment now always produces complete reserve information
2. **Determinism**: Liquidation builder uses exact plan-provided reserves (no float math guessing)
3. **Visibility**: Summary statistics and validation warnings help diagnose issues
4. **Safety**: Plans with incomplete information are rejected early with clear reasons

### Risk Assessment
- **Low Risk**: Changes are surgical and preserve backward compatibility
- **Fallback Preserved**: Liquidation builder still falls back to USD selection if needed
- **Logging**: All changes include detailed logging for debugging
- **Validation**: Plans are validated before execution, preventing runtime failures

## Files Changed

1. `src/commands/snapshotCandidates.ts` - Fix enrichment to use `byReserve` lookup
2. `src/kamino/liquidationBuilder.ts` - Make reserve selection deterministic
3. `scripts/test_scheduler_with_forecast.ts` - Add plan validation
4. `test/verify_reserve_enrichment.test.ts` - Unit tests for verification

## Next Steps

1. ✅ Code changes complete
2. ⏳ Request code review
3. ⏳ Run CodeQL security scan
4. ⏳ Address any review feedback
5. ⏳ Test in real environment with live RPC
6. ⏳ Monitor first production run for issues
