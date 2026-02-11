# Quick Reference: Reserve Pubkey Fix

## What Changed?

The liquidation bot now extracts and validates obligation-specific reserve pubkeys to prevent `Custom(6006)` errors.

## Quick Start

### 1. Generate Fresh Plans (Required)

```bash
npm run snapshot:candidates
```

This command will:
- Load all obligations from the market
- Extract reserve pubkeys from each obligation's actual borrows and deposits
- Create candidates with obligation-specific reserve information

### 2. Generate Transaction Queue

```bash
npm run test:scheduler:forecast
```

or your preferred scheduler command to convert candidates into plans.

### 3. Run the Bot

```bash
npm run bot:run:wsl
```

The bot will now:
- Use obligation-specific reserves from the plans
- Validate reserves match before building liquidation instructions
- Show detailed diagnostics for any Custom(6006) errors

## What to Look For in Logs

### ✅ Success - Reserve Validation Passed

```
[Executor] Using expected repay reserve: 9rCp2...
[Executor] Using expected collateral reserve: 4zMb1...
[LiqBuilder] Selected repay: 9rCp2..., collateral: 4zMb1...
[LiqBuilder] Preflight validation passed: reserves match plan
```

### ⚠️ Warning - Legacy Plan (No Reserve Pubkeys)

```
[Executor] ⚠️  Warning: Plan is missing reserve pubkeys
[Executor]    This plan was likely created before the reserve-tracking fix.
[Executor]    Recommend: Regenerate tx_queue.json with npm run snapshot:candidates
```

**Action**: Regenerate plans with `npm run snapshot:candidates`

### ❌ Error - Reserve Mismatch

```
[LiqBuilder] Preflight validation failed: repay reserve mismatch.
Expected: 9rCp2..., Selected: 5kXNw...
This obligation's borrows don't match the planned reserves.
```

**Action**: Obligation changed since plan was created. Regenerate plans.

### ❌ Error - Custom(6006) with Diagnostics

```
[Executor] ═══ CUSTOM ERROR DIAGNOSTIC ═══
  Error Code: Custom(6006)
  Decoded: InvalidAccountInput - Account mismatch
  Obligation: 5kXNw...
  Repay Reserve (from plan): 9rCp2...
  Collateral Reserve (from plan): 4zMb1...

  💡 LIKELY CAUSE: Reserves don't match obligation's actual borrows/deposits
  ✅ SOLUTION: Regenerate tx_queue.json with npm run snapshot:candidates
```

**Action**: Regenerate plans with `npm run snapshot:candidates`

## Troubleshooting

### Issue: Still getting Custom(6006) after regenerating plans

**Possible causes**:
1. **Obligation changed after plan creation**: Regenerate plans more frequently
2. **Allowlist filtering issue**: Check if obligation has USDC/SOL pairs
3. **Stale data**: Clear cache and regenerate: `rm -rf data/*.json && npm run snapshot:candidates`

### Issue: Plans are missing reserve pubkeys

**Solution**:
```bash
# Clear old plans
rm data/tx_queue.json data/candidates.json

# Regenerate with reserve tracking
npm run snapshot:candidates
npm run test:scheduler:forecast
```

### Issue: Want to skip obligations without USDC/SOL pairs

**Current behavior**: All obligations are included (fallback to first borrow/deposit)

**To enforce strict filtering** (future enhancement):
1. Add filtering in `snapshotCandidates.ts` after reserve selection
2. Skip candidates where repayMint !== USDC or collateralMint !== SOL
3. Log skipped obligations for monitoring

## Key Files Modified

- `src/commands/snapshotCandidates.ts` - Reserve extraction
- `src/strategy/candidateSelector.ts` - Interface updates
- `src/kamino/liquidationBuilder.ts` - Preflight validation
- `src/execute/executor.ts` - Reserve passing + error logging
- `test/reserve-pubkeys.test.ts` - Unit tests

## Testing Your Changes

Run all tests to verify everything works:

```bash
npm test
```

Should show:
```
✓ test/candidate-selector.test.ts (12 tests)
✓ test/reserve-pubkeys.test.ts (4 tests)

Test Files  2 passed (2)
     Tests  16 passed (16)
```

## Migration Checklist

- [ ] Clear old plans: `rm data/tx_queue.json data/candidates.json`
- [ ] Regenerate with reserve tracking: `npm run snapshot:candidates`
- [ ] Generate transaction queue: `npm run test:scheduler:forecast`
- [ ] Run bot and verify logs show reserve validation: `npm run bot:run:wsl`
- [ ] Monitor for Custom(6006) errors (should be eliminated or rare)
- [ ] Check that successful liquidations work as expected

## Expected Outcomes

After implementing this fix:

1. **Fewer Custom(6006) errors**: Plans use obligation-specific reserves
2. **Better diagnostics**: Clear error messages when issues occur
3. **Early detection**: Preflight validation catches mismatches before simulation
4. **Business-rule failures**: Most errors will be 6016 (ObligationHealthy) or 6017 (ObligationStale), not 6006

## Questions?

See `RESERVE_PUBKEY_FIX_SUMMARY.md` for detailed implementation guide.
