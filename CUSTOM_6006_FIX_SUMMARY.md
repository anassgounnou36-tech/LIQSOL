# Fix Custom(6006) Implementation Summary

## Problem Statement

The liquidation execution was failing with `InstructionError [7, { Custom: 6006 }]` (InvalidAccountInput) during dry-run simulation. The root cause was that `refreshObligation` was being called with **ZERO remaining accounts**, but Kamino's protocol requires **ALL deposit + borrow reserves** of the obligation to be passed as remaining accounts and refreshed in the same transaction.

## Solution Overview

Implemented a comprehensive fix with four main parts:

### Part A: Gather All Obligation Reserves
Extracted all unique reserve pubkeys from both borrows and deposits:
- Filter out default pubkeys (11111...111)
- Deduplicate using Set to handle reserves used in both borrow and collateral
- Validate that expected reserves from plan are present

### Part B: Refresh ALL Reserves
Changed from refreshing only 2 reserves (repay + collateral) to refreshing ALL obligation reserves:
- Created `buildRefreshReserveIx` helper function for any reserve
- Prioritize repay and collateral reserves first (critical for liquidation)
- Added safety cap (MAX_RESERVES_PER_TX = 10) with warning
- Include all oracle accounts automatically via SDK

### Part C: Wire Remaining Accounts to refreshObligation (CRITICAL FIX)
**The Key Fix:**
```typescript
// BEFORE (caused Custom 6006):
refreshObligation({ lendingMarket, obligation }, [], programId)

// AFTER (fixed):
const remainingAccounts = uniqueReserves.map(r => ({
  address: address(r),
  role: 0 as const, // READONLY
}));
refreshObligation({ lendingMarket, obligation }, remainingAccounts, programId)
```

### Part D: Enhanced Error Diagnostics
Added instruction index→label mapping and comprehensive simulation log printing:
- Build parallel `labels` array alongside `ixs` array
- Print full simulation logs on error
- Show instruction map with visual marker for failed instruction
- Enhanced Custom(6006) error guidance

## Technical Details

### File: src/kamino/liquidationBuilder.ts

**Lines 316-362: Part A - Gather reserves**
```typescript
const allReservePubkeys = new Set<string>();

// Add all borrow reserves
for (const borrow of borrows) {
  const reservePubkey = borrow.borrowReserve.toString();
  if (reservePubkey !== PublicKey.default.toString()) {
    allReservePubkeys.add(reservePubkey);
  }
}

// Add all deposit reserves
for (const deposit of deposits) {
  const reservePubkey = deposit.depositReserve.toString();
  if (reservePubkey !== PublicKey.default.toString()) {
    allReservePubkeys.add(reservePubkey);
  }
}

const uniqueReserves = Array.from(allReservePubkeys);
```

**Lines 443-509: Part B - Refresh all reserves**
- Helper function to build refresh instruction for any reserve
- Prioritize repay/collateral, then add others
- Cap at 10 reserves with warning for typical Kamino obligations

**Lines 510-524: Part C - Pass remaining accounts**
```typescript
const remainingAccounts = uniqueReserves.map(r => ({
  address: address(r),
  role: 0 as const, // READONLY per Kamino SDK
}));

const obligationRefreshIx = refreshObligation({
  lendingMarket: address(p.marketPubkey.toBase58()),
  obligation: address(p.obligationPubkey.toBase58()),
}, remainingAccounts, address(p.programId.toBase58()));
```

### File: src/execute/executor.ts

**Modified buildFullTransaction signature:**
```typescript
async function buildFullTransaction(...): Promise<{ ixs: TransactionInstruction[]; labels: string[] }>
```

**Added instruction labeling:**
- `computeBudget:limit`, `computeBudget:price`
- `flashBorrow`
- `ata:repay`, `ata:collateral`, `ata:withdraw`
- `refreshReserve:0`, `refreshReserve:1`, ...
- `refreshObligation`
- `liquidate`
- `swap:setup:0`, `swap:0`, `swap:cleanup:0`, ...
- `flashRepay`

**Enhanced error diagnostics (lines 540-620):**
```typescript
if (sim.value.logs && sim.value.logs.length > 0) {
  console.error('\n[Executor] ═══ SIMULATION LOGS ═══');
  sim.value.logs.forEach((log, i) => {
    console.error(`  [${i}] ${log}`);
  });
}

// Print instruction map with failed instruction marked
console.error('\n  Instruction Map:');
labels.forEach((label, idx) => {
  const marker = idx === ixIndex ? ' ← FAILED HERE' : '';
  console.error(`    [${idx}] ${label}${marker}`);
});
```

## Testing

### Created test/refresh-obligation-remaining-accounts.test.ts

**5 comprehensive tests:**
1. ✅ Extract unique reserves from borrows and deposits
2. ✅ Handle obligation with single reserve (dedupe)
3. ✅ Handle obligation with many reserves (stress test)
4. ✅ Validate expected reserves are present
5. ✅ Compare old bug (empty array) vs new fix

**Results:**
- All 5 tests pass ✅
- All existing liquidation tests pass (7/7) ✅
- No new test failures introduced ✅

## Expected Impact

### Before Fix
```
Simulation Error: InstructionError [7, { Custom: 6006 }]
- No visibility into which instruction failed
- refreshObligation received 0 reserves
- Kamino program rejected due to missing reserve accounts
```

### After Fix
```
Simulation Success (or better error diagnostics):
- refreshObligation receives all N reserves from obligation
- Full instruction map printed on error
- Simulation logs visible for debugging
- Custom(6006) errors show clear troubleshooting guidance
```

## Validation Checklist

- [x] Code compiles without new TypeScript errors
- [x] All unit tests pass (5/5)
- [x] No regression in existing tests
- [x] Instruction labels properly assigned
- [x] Remaining accounts properly formatted as AccountMeta
- [x] Expected reserves validated against unique set
- [x] TX size safety with MAX_RESERVES_PER_TX cap
- [x] Enhanced error diagnostics working

## Key Insights

1. **Kamino Protocol Requirement:** refreshObligation MUST receive ALL obligation reserves as remaining accounts, not just the ones being liquidated.

2. **SDK Type Expectations:** Remaining accounts must be `AccountMeta` objects with `{address, role}` structure, not raw Address objects.

3. **Typical Obligation Size:** Most Kamino obligations have 1-4 reserves, so the 10-reserve cap provides ample safety margin.

4. **Debugging Enhancement:** Instruction labels are critical for debugging complex multi-instruction transactions.

## Future Considerations

1. **Dynamic TX Size Management:** If obligations with >10 reserves become common, implement smarter TX packing or multiple TXs.

2. **Reserve Ordering Optimization:** Could optimize order of reserves in remaining accounts for better cache locality.

3. **Monitoring:** Add metrics to track distribution of reserves per obligation to validate cap assumptions.

## References

- Kamino SDK: `@kamino-finance/klend-sdk` v7.3.9 (minimum required version)
- refreshObligation IDL: `node_modules/@kamino-finance/klend-sdk/src/@codegen/klend/instructions/refreshObligation.ts`
- Solana Kit: `@solana/kit` v6.0.1
- Document created: February 2026

## Commits

1. `c0c94b7` - Implement fix for Custom(6006): wire refresh_obligation remaining accounts + refresh all reserves + add instruction labels
2. `fdffeb3` - Add unit test for refreshObligation remaining accounts fix
3. `88b48d9` - Fix TypeScript errors: use AccountMeta format for remainingAccounts and remove unused variable
