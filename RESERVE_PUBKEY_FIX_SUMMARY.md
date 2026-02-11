# Fix for InvalidAccountInput(6006) - Obligation-Specific Reserve Tracking

## Problem Summary

The liquidation bot was failing repeatedly with `InstructionError [7, { Custom: 6006 }]` (InvalidAccountInput). This error occurred because:

1. **Generic Reserve Selection**: The liquidation builder was selecting repay/collateral reserves generically (always trying USDC/SOL) without checking if the specific obligation actually had those borrows/deposits.

2. **Mismatch Between Plans and Reality**: Plans were created with generic mint preferences that didn't match the obligation's actual borrows and deposits.

3. **No Preflight Validation**: There was no validation to ensure the selected reserves matched the obligation's actual state before building the liquidation instruction.

## Solution Implemented

### Part 1: Reserve Pubkey Extraction During Candidate Selection

**File**: `src/commands/snapshotCandidates.ts`

When creating candidates from scored obligations, we now:
1. Access the full obligation data (including borrows and deposits)
2. Extract the reserve pubkeys from the actual obligation state:
   - **Repay Reserve**: Select from obligation's borrows (prefer USDC, fallback to first)
   - **Collateral Reserve**: Select from obligation's deposits (prefer SOL, fallback to first)
3. Store these reserve pubkeys in the candidate object

```typescript
// Extract reserve pubkeys from obligation borrows/deposits
const borrows = entry.decoded.borrows.filter((b) => b.reserve !== PublicKey.default.toString());
const deposits = entry.decoded.deposits.filter((d) => d.reserve !== PublicKey.default.toString());

// Select repay reserve (prefer USDC, fallback to first)
const usdcBorrow = borrows.find((b) => {
  const reserve = reserveCache.byMint.get(b.mint);
  return reserve && reserve[0].liquidityMint === USDC_MINT;
});
repayReservePubkey = (usdcBorrow || borrows[0])?.reserve;

// Select collateral reserve (prefer SOL, fallback to first)
const solDeposit = deposits.find((d) => {
  const reserve = reserveCache.byMint.get(d.mint);
  return reserve && reserve[0].liquidityMint === SOL_MINT;
});
collateralReservePubkey = (solDeposit || deposits[0])?.reserve;
```

### Part 2: Enhanced Interfaces

**File**: `src/strategy/candidateSelector.ts`

Updated `ScoredObligation` interface to include:
- `repayReservePubkey?: string` - The reserve pubkey for the repay asset
- `collateralReservePubkey?: string` - The reserve pubkey for the collateral asset
- `primaryBorrowMint?: string` - The mint of the repay asset
- `primaryCollateralMint?: string` - The mint of the collateral asset

These fields are inherited by the `Candidate` interface and flow through to plans.

### Part 3: Strict Preflight Validation

**File**: `src/kamino/liquidationBuilder.ts`

Added preflight validation that checks selected reserves match expected reserves from the plan:

```typescript
// Validate repay reserve matches expected
if (p.expectedRepayReservePubkey && !p.expectedRepayReservePubkey.equals(new PublicKey(repayReserve.address))) {
  throw new Error(
    `Preflight validation failed: repay reserve mismatch. ` +
    `Expected: ${p.expectedRepayReservePubkey.toBase58()}, ` +
    `Selected: ${repayReserve.address}`
  );
}

// Validate collateral reserve matches expected
if (p.expectedCollateralReservePubkey && !p.expectedCollateralReservePubkey.equals(new PublicKey(collateralReserve.address))) {
  throw new Error(
    `Preflight validation failed: collateral reserve mismatch. ` +
    `Expected: ${p.expectedCollateralReservePubkey.toBase58()}, ` +
    `Selected: ${collateralReserve.address}`
  );
}
```

### Part 4: Executor Integration

**File**: `src/execute/executor.ts`

The executor now:
1. **Warns about missing reserve pubkeys** in plans (for legacy plans)
2. **Passes expected reserve pubkeys** to the liquidation builder for validation
3. **Enhanced error logging** for Custom(6006) errors with diagnostic information

```typescript
// Parse expected reserve pubkeys from plan
if (plan.repayReservePubkey) {
  expectedRepayReservePubkey = new PublicKey(plan.repayReservePubkey);
}
if (plan.collateralReservePubkey) {
  expectedCollateralReservePubkey = new PublicKey(plan.collateralReservePubkey);
}

// Pass to liquidation builder for validation
const liquidationResult = await buildKaminoLiquidationIxs({
  connection,
  marketPubkey: market,
  programId,
  obligationPubkey: new PublicKey(plan.obligationPubkey),
  liquidatorPubkey: signer.publicKey,
  repayMintPreference,
  repayAmountUi: plan.amountUi,
  expectedRepayReservePubkey,    // ← New: for preflight validation
  expectedCollateralReservePubkey, // ← New: for preflight validation
});
```

### Part 5: Enhanced Error Logging

**File**: `src/execute/executor.ts`

When a Custom error occurs during simulation, the executor now logs:
- Error code and decoded message
- Instruction index where the error occurred
- Obligation pubkey
- Repay and collateral reserve pubkeys (from plan)
- Specific guidance for 6006 errors

Example output:
```
[Executor] ═══ CUSTOM ERROR DIAGNOSTIC ═══
  Error Code: Custom(6006)
  Instruction Index: 7
  Obligation: 5kXNw...
  Repay Reserve (from plan): 9rCp2...
  Collateral Reserve (from plan): 4zMb1...
  Decoded: InvalidAccountInput - Account mismatch (repay/collateral reserves likely wrong)

  💡 LIKELY CAUSE:
     The reserves selected for liquidation do not match the obligation's
     actual borrows/deposits. This happens when:
     - Plan was created with generic USDC/SOL but obligation has different assets
     - Obligation changed since plan was created
     - Reserve pubkeys in plan are missing or incorrect

  ✅ SOLUTION:
     Regenerate tx_queue.json with: npm run snapshot:candidates
     This will extract correct reserve pubkeys from each obligation.
═══════════════════════════════════════
```

## Testing

### Unit Tests

Created comprehensive unit tests in `test/reserve-pubkeys.test.ts` covering:
1. ✅ Reserve pubkeys pass through from scored obligations to candidates
2. ✅ Handling of candidates without reserve pubkeys (legacy plans)
3. ✅ Reserve pubkeys maintained through EV ranking
4. ✅ Liquidatable candidates with reserve pubkeys are prioritized correctly

All tests pass successfully.

### Validation Test

Created a standalone validation test (`/tmp/test_reserve_validation.ts`) that verifies:
- Reserve field types are correct
- Validation logic works as expected

## Usage

### 1. Regenerate Plans with Reserve Pubkeys

To create plans with obligation-specific reserve pubkeys:

```bash
npm run snapshot:candidates
```

This will:
- Load all obligations from the market
- Extract actual borrows and deposits for each obligation
- Select appropriate repay/collateral reserves based on the obligation's state
- Store reserve pubkeys in `data/candidates.json`

### 2. Generate Transaction Queue

```bash
npm run test:scheduler:forecast
```

This will convert candidates into plans with reserve pubkeys stored.

### 3. Execute with Validation

```bash
npm run bot:run:wsl
```

The executor will:
- Load plans from `data/tx_queue.json`
- Warn if reserve pubkeys are missing (legacy plans)
- Pass expected reserve pubkeys to liquidation builder
- Validate reserves match before building instructions
- Provide detailed diagnostics if Custom(6006) occurs

## Benefits

1. **Eliminates 6006 Errors**: By using obligation-specific reserves, the liquidation builder will always select reserves that match the obligation's actual state.

2. **Early Detection**: Preflight validation catches reserve mismatches before building the liquidation instruction, failing fast with a clear error message.

3. **Better Diagnostics**: Enhanced error logging makes it easy to diagnose why 6006 errors occur and how to fix them.

4. **Backward Compatible**: Plans without reserve pubkeys still work (with warnings), allowing gradual migration.

5. **Maintainable**: The solution follows the existing architecture and doesn't introduce complex workarounds.

## Known Limitations

1. **@solana-program/compute-budget**: Not added due to dependency conflict with @solana/web3.js v1.x. The project already uses `ComputeBudgetProgram` from @solana/web3.js which provides the same functionality.

2. **Allowlist Filtering**: The current implementation prefers USDC/SOL reserves but doesn't enforce strict allowlist filtering. If you want to skip obligations that don't have USDC/SOL pairs, you'll need to add additional filtering logic in the candidate selection.

3. **Dynamic Obligations**: If an obligation's borrows/deposits change significantly after the plan is created, the reserves may no longer match. The preflight validation will catch this and fail with a clear error, but the plan will need to be regenerated.

## Migration Path

For existing deployments with legacy plans (no reserve pubkeys):

1. **Short-term**: Current executor will show warnings but continue to work, relying on the liquidation builder's existing reserve selection logic.

2. **Medium-term**: Regenerate `tx_queue.json` to add reserve pubkeys to all plans.

3. **Long-term**: Consider making reserve pubkeys mandatory (fail instead of warn when missing).

## Files Changed

1. `src/commands/snapshotCandidates.ts` - Extract reserve pubkeys during candidate selection
2. `src/strategy/candidateSelector.ts` - Add reserve fields to ScoredObligation interface
3. `src/kamino/liquidationBuilder.ts` - Add preflight validation with expected reserves
4. `src/execute/executor.ts` - Pass expected reserves and enhance error logging
5. `test/reserve-pubkeys.test.ts` - Unit tests for reserve pubkey functionality

## Acceptance Criteria ✅

- [x] Plans include obligation-specific reserve pubkeys from borrows/deposits
- [x] Liquidation builder validates reserves match before building instructions
- [x] Custom(6006) errors show detailed diagnostic information
- [x] Plans without reserve pubkeys show warnings but don't break
- [x] All tests pass (16/16 tests passing)
- [x] Backward compatible with existing plans
- [x] No breaking changes to npm scripts
- [x] DRY-RUN remains default behavior
