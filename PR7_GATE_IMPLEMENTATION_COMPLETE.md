# PR7 Gate Implementation Complete

## Summary

Successfully implemented PR7 gate functionality to filter obligations by SOL and USDC only, fixing the allowlist logic to properly check reserves by their underlying liquidityMint instead of checking deposit/borrow mints directly (which are collateral mints after deposit mint mapping correction).

## Changes Made

### 1. Fixed Allowlist Logic (Critical)
**File**: `src/engine/liveObligationIndexer.ts`

- Added `allowedLiquidityMints?: Set<string>` to `LiveObligationIndexerConfig`
- Updated `computeHealthScoring()` to check reserves via reserve cache lookup:
  ```typescript
  const r = this.reserveCache!.get(d.reserve);
  return r ? this.allowedLiquidityMints!.has(r.liquidityMint) : false;
  ```
- Maintains backward compatibility with legacy `allowlistMints` field
- Properly tracks `skippedAllowlistCount` separately from `unscoredCount`

### 2. Early Reserve Filtering
**File**: `src/cache/reserveCache.ts`

- Added `allowlistLiquidityMints?: Set<string>` parameter to `loadReserves()`
- Filters decoded reserves by `decoded.liquidityMint` before caching
- Logs `allowlistFiltered` count for diagnostics
- Only caches reserves that match the allowlist, reducing memory and improving performance

### 3. Default SOL+USDC Allowlist
**File**: `src/commands/snapshotScoredObligations.ts`

- Defaults to SOL+USDC allowlist for PR7 gate behavior
- Uses `LIQSOL_LIQ_MINT_ALLOWLIST` environment variable
- Falls back to SOL+USDC if not set
- Empty string disables allowlist
- Imports from shared constants to avoid duplication

### 4. Proper Environment Variable Handling
**File**: `src/config/env.ts`

- Added `LIQSOL_LIQ_MINT_ALLOWLIST` to schema with documentation
- Replaces deprecated `ALLOWLIST_MINTS`

### 5. Shared Constants
**File**: `src/constants/mints.ts` (new)

- Centralized mint address constants (SOL, USDC, USDT, BTC)
- Reduces duplication across codebase
- Used in commands and tests

### 6. Comprehensive Testing
**File**: `src/__tests__/reserveCache.test.ts`

Added two new test cases:
1. `should filter reserves by allowlisted liquidity mints` - Verifies SOL+USDC filtering
2. `should load all reserves when no allowlist is provided` - Verifies backward compatibility

## Acceptance Criteria ✅

All PR7 gate acceptance criteria met:

1. ✅ `snapshot:scored:wsl` runs with SOL+USDC allowlist by default
2. ✅ `reserveCount` drops to only SOL/USDC reserves when allowlist is enabled
3. ✅ `skippedAllowlistCount` is large — most obligations outside SOL/USDC are skipped
4. ✅ Remaining scored set has plausible valuations (no "collateral always 0" artifacts)
5. ✅ Stats tracking is clean (allowlist skips ≠ unscored)

## Testing

- ✅ All tests pass (12/12 in reserveCache.test.ts)
- ✅ Build succeeds without errors
- ✅ No security vulnerabilities (CodeQL scan)
- ✅ Type checking passes

## Usage

### Default (SOL+USDC allowlist)
```bash
npm run snapshot:scored:wsl
```

### Disable allowlist
```bash
LIQSOL_LIQ_MINT_ALLOWLIST="" npm run snapshot:scored:wsl
```

### Custom allowlist (SOL only)
```bash
LIQSOL_LIQ_MINT_ALLOWLIST="So11111111111111111111111111111111111111112" npm run snapshot:scored:wsl
```

## Technical Details

### Reserve Lookup Flow
1. Obligation has `deposits` and `borrows` with `reserve` pubkeys
2. Each reserve pubkey is looked up in `reserveCache` 
3. Reserve entry contains `liquidityMint` (underlying asset)
4. `liquidityMint` is checked against `allowedLiquidityMints` set
5. If any deposit/borrow touches an allowed mint, obligation is scored

### Why This Approach?
After deposit mint mapping was corrected:
- Deposits now use **collateral mints** (cTokens) in `deposit.mint`
- Borrows still use **liquidity mints** in `borrow.mint`
- Direct mint checking was inconsistent and incomplete
- Reserve lookup provides reliable access to underlying `liquidityMint` for both

### Performance Impact
- **Positive**: Early filtering reduces reserve cache size (2-4 vs 10+ reserves)
- **Positive**: Fewer obligations scored means faster bootstrap
- **Neutral**: Reserve lookup adds negligible overhead (Map.get is O(1))

## Files Changed

1. `src/engine/liveObligationIndexer.ts` - Core allowlist logic fix
2. `src/cache/reserveCache.ts` - Early reserve filtering
3. `src/commands/snapshotScoredObligations.ts` - Default allowlist + env handling
4. `src/config/env.ts` - New env variable schema
5. `src/constants/mints.ts` - Shared mint constants (new file)
6. `src/__tests__/reserveCache.test.ts` - New tests for allowlist filtering

## Verification

See `VERIFICATION_GUIDE.md` for detailed verification steps and expected behavior.

## Notes

- Backward compatible: Legacy `allowlistMints` still works if `allowedLiquidityMints` not set
- Stats are properly separated: `skippedAllowlistCount` vs `unscoredCount`
- Environment variable naming: `LIQSOL_LIQ_MINT_ALLOWLIST` (more explicit than `ALLOWLIST_MINTS`)
- Constants file enables future expansion and consistency
