# Fix for Custom(6006): refreshObligation Canonical Ordering

## Summary
Fixed simulation error `InstructionError: [7, { Custom: 6006 }]` by ensuring refreshObligation's remaining accounts are passed in canonical order expected by Kamino protocol.

## Root Cause
Previous implementation used a `Set` to deduplicate reserves, which destroyed the canonical ordering. Kamino's `refreshObligation` instruction validates remaining accounts against the obligation's reserve legs in a predictable order: **deposits first, then borrows**.

## Changes Made

### 1. src/kamino/liquidationBuilder.ts (Lines 320-345)
**Fixed canonical ordering:**
```typescript
// BEFORE (destroyed ordering):
const allReservePubkeys = new Set<string>();
for (const borrow of borrows) { allReservePubkeys.add(...); }
for (const deposit of deposits) { allReservePubkeys.add(...); }
const uniqueReserves = Array.from(allReservePubkeys); // UNDEFINED ORDER

// AFTER (preserves canonical order):
const orderedReserves: string[] = [];
const seenReserves = new Set<string>();

// Deposits FIRST (in order)
for (const deposit of deposits) {
  if (!seenReserves.has(reservePubkey)) {
    orderedReserves.push(reservePubkey);
    seenReserves.add(reservePubkey);
  }
}

// Then borrows (in order) - skip duplicates
for (const borrow of borrows) {
  if (!seenReserves.has(reservePubkey)) {
    orderedReserves.push(reservePubkey);
    seenReserves.add(reservePubkey);
  }
}

const uniqueReserves = orderedReserves; // CANONICAL ORDER PRESERVED
```

**Key improvements:**
- Processes deposits before borrows (canonical Kamino order)
- Preserves order within each category
- Deduplicates without reordering (keeps first occurrence)

### 2. src/execute/executor.ts (Line 591)
**Enhanced error diagnostics:**
- Updated error 6006 description: "InvalidAccountInput - Remaining accounts order or reserve mismatch"
- Added error 6015: "LiquidationTooSmall"
- Already has comprehensive instruction map and simulation log printing

### 3. test/refresh-obligation-remaining-accounts.test.ts
**Updated all tests to validate canonical ordering:**
- Test 1: Validates deposits→borrows order with explicit position checks
- Test 2: Single reserve deduplication
- Test 3: Stress test with overlap (validates deduplication preserves order)
- Test 4: Expected reserve validation
- Test 5: Empty array comparison

## Testing Performed

### ✅ Standalone Logic Test
Created and ran `/tmp/test-canonical-ordering.js` - all tests passed:
- Deposits processed first ✓
- Borrows processed second ✓
- Duplicates skipped without reordering ✓
- Final order: [deposit1, deposit2, shared, borrow1, borrow2] ✓

### ✅ TypeScript Compilation
- No new TypeScript errors in modified files
- All existing build errors are pre-existing and unrelated

### ✅ Code Review
- Addressed all review comments
- Added clarifying comments for test cases

### ✅ Security Scan (CodeQL)
- JavaScript: 0 alerts
- No security vulnerabilities introduced

## Expected Impact

### Before Fix
```
[Executor] Simulation error: { InstructionError: [ 7, { Custom: 6006 } ] }
- refreshObligation receives reserves in undefined order (Set→Array)
- Kamino protocol validation fails on remaining accounts mismatch
- Simulation fails even with correct reserves
```

### After Fix
```
✅ refreshObligation receives reserves in canonical order (deposits→borrows)
✅ Kamino protocol validation passes
✅ If simulation fails, it's a meaningful error:
    - 6015: LiquidationTooSmall
    - 6016: ObligationHealthy
    - 6017: ObligationStale
    - Not 6006 (ordering issue)
```

## Testing Instructions (From Problem Statement)

To validate the fix works end-to-end, follow these steps in WSL:

### 1. Regenerate Pipeline
```bash
npm run snapshot:obligations:wsl
npm run snapshot:scored:wsl
npm run snapshot:candidates:wsl
npm run test:scheduler:forecast:wsl
```

### 2. Run Bot Dry-Run
```bash
npm run bot:run:wsl
```

### Expected Results
- ✅ Simulation should no longer fail with Custom(6006) due to refreshObligation ordering
- ✅ If simulation fails, it shows meaningful protocol error (6015, 6016, 6017, etc.)
- ✅ Instruction map printed showing which instruction failed
- ✅ Simulation logs visible for debugging

## Files Changed
1. `src/kamino/liquidationBuilder.ts` - Fixed canonical ordering logic
2. `src/execute/executor.ts` - Updated error code 6006 description
3. `test/refresh-obligation-remaining-accounts.test.ts` - Updated tests to validate ordering

## Commits
1. `f0b1e4b` - Fix refreshObligation remaining accounts canonical ordering
2. `2a5d66a` - Address code review comments: clarify test reserve overlap

## Security Summary
No security vulnerabilities introduced:
- CodeQL scan: 0 alerts
- Changes only affect ordering of existing data
- No new dependencies added
- No credential handling modified
- Input validation remains unchanged

## Additional Notes

### Why Canonical Order Matters
Kamino's on-chain program validates that remaining accounts match the obligation's internal state. The obligation state stores deposits and borrows in specific slots, and the program iterates through them in a predictable order during validation. Passing reserves in the wrong order causes the validator to compare wrong reserves, triggering InvalidAccountInput (6006).

### Deduplication Strategy
We use a separate `seenReserves` Set for O(1) duplicate checking while building the ordered array. This preserves the first occurrence's position (from deposits) and skips later duplicates (from borrows).

### No Performance Impact
- Time complexity: O(n) where n = deposits + borrows (same as before)
- Space complexity: O(n) (same as before)
- No additional RPC calls or computations

### Compatibility
- Works with existing Kamino SDK (v7.3.9+)
- No breaking changes to public APIs
- Backward compatible with existing plans
