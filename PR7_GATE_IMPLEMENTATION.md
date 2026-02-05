# PR7 Gate Implementation Summary

## Overview
This PR implements critical fixes to deposit/borrow mint mapping and adds SOL/USDC allowlist mode for targeted validation during snapshot scoring.

## Changes Implemented

### 1. Fixed Deposit/Borrow Mint Mapping (CRITICAL)

**Problem**: Deposits were labeled/processed using liquidity mint instead of collateral mint (cToken), which breaks decimals/exchange-rate handling and yields tiny/zero collateral.

**Solution**: Split the single `reserveMintCache` into two separate caches:
- `reserveLiquidityMintCache`: Maps reserve pubkey → liquidity mint (for borrows)
- `reserveCollateralMintCache`: Maps reserve pubkey → collateral mint (for deposits)

**Files Modified**:
- `src/kamino/decode/obligationDecoder.ts`:
  - Replaced single cache with two caches
  - Updated `setReserveMintCache()` to accept both liquidity and collateral mints
  - Updated deposit mapping to use `reserveCollateralMintCache`
  - Updated borrow mapping to use `reserveLiquidityMintCache`
  
- `src/kamino/decoder.ts`:
  - Updated wrapper function signature to match new implementation

- `src/cache/reserveCache.ts`:
  - Updated call to `setReserveMintCache()` to pass both mints
  - Added documentation explaining the dual-mint storage

- `src/__tests__/reserveCache.test.ts`:
  - Updated test expectations to verify both mints are passed

**Impact**: 
- Deposits now correctly use collateral mint for decimals and exchange rate
- Borrows now correctly use liquidity mint for pricing and decimals
- Fixes corrupted liquidation rankings caused by wrong mint mapping

### 2. Added SOL/USDC Allowlist Mode

**Problem**: Validation across 127k obligations is noisy; needed a deterministic gate to validate SOL + USDC correctness first.

**Solution**: Added optional allowlist mode that restricts scoring to obligations touching specific mints.

**Files Modified**:
- `src/engine/liveObligationIndexer.ts`:
  - Added `allowlistMints?: string[]` to `LiveObligationIndexerConfig`
  - Added `skippedAllowlistCount` to stats tracking
  - Added allowlist check in `computeHealthScoring()` method
  - Skips obligations that don't touch any allowlisted mint
  - Updated `getStats()` to return `skippedAllowlistCount`

- `src/commands/snapshotScoredObligations.ts`:
  - Added SOL and USDC mint constants
  - Parse `ALLOWLIST_MINTS` from environment
  - Pass allowlist to indexer configuration
  - Updated stats output to show skipped allowlist count

- `src/config/env.ts`:
  - Added `ALLOWLIST_MINTS` as optional string field

- `.env.example`:
  - Added commented example for `ALLOWLIST_MINTS`

**Usage**:
```bash
# Enable allowlist mode for SOL and USDC only
export ALLOWLIST_MINTS="So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
npm run snapshot:scored:wsl
```

**Impact**:
- Enables focused validation on SOL/USDC obligations
- Reduces noise from other assets during validation
- Tracks skipped obligations separately from unscored obligations
- Maintains backward compatibility (allowlist is optional)

## Testing

All tests pass:
```
Test Files  16 passed (16)
Tests  115 passed | 2 skipped | 4 todo (121)
```

## Backward Compatibility

Both changes are fully backward compatible:
1. **Mint mapping fix**: Internal cache change, transparent to consumers
2. **Allowlist mode**: Optional feature, disabled by default

## Well-Known Mints

For reference, the following well-known mints can be used with allowlist mode:
- **SOL (Wrapped)**: `So11111111111111111111111111111111111111112`
- **USDC**: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

## Next Steps

1. Test with production data using allowlist mode
2. Verify liquidation rankings are now correct
3. Validate SOL/USDC obligations score correctly
4. Gradually expand validation to other assets
