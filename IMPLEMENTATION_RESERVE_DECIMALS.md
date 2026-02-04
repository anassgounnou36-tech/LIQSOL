# Reserve Decimals Parsing Fix - Implementation Summary

## Problem Statement
Production runs were failing with MISSING_EXCHANGE_RATE errors due to missing mint decimals in reserve accounts. When reserves decoded with undefined `mintDecimals`, the `parseU8Like()` function threw exceptions, preventing reserves from being cached and causing collateral exchange rate computation to fail.

## Root Cause
- Many reserves decode with missing `liquidity.mintDecimals` or `collateral.mintDecimals` (undefined)
- Current `parseU8Like()` throws on undefined, dropping the entire reserve
- Without decimals, exchange-rate math fails with `10n ** undefined` errors
- This caused zero exchange rates and MISSING_EXCHANGE_RATE failures

## Solution Implemented

### 1. Tolerant Decimals Parsing
**File**: `src/kamino/decode/reserveDecoder.ts`

Updated `parseU8Like()` to return `-1` as a sentinel value for missing decimals instead of throwing:
```typescript
function parseU8Like(v: unknown, fieldName: string): number {
  // Return -1 for undefined/null (missing field)
  if (v === undefined || v === null) {
    return -1;
  }
  // Continue throwing for invalid types/ranges when value exists
  // ... validation logic ...
}
```

**Key Points**:
- `-1` explicitly marks "unknown/missing" (0 is a valid decimals value)
- Still validates and throws for malformed non-null values
- Allows reserve decoding to continue with sentinel value

### 2. SPL Mint Fallback Helper
**File**: `src/utils/splMint.ts` (NEW)

Created utility to parse decimals directly from SPL Token Mint account data:
```typescript
export function parseSplMintDecimals(data: Buffer): number | null {
  if (!data || data.length < 45) return null;
  const decimals = data[44];  // Decimals at byte offset 44
  return Number.isInteger(decimals) ? decimals : null;
}
```

**SPL Token Mint Structure**:
- Bytes 0-35: mint_authority
- Bytes 36-43: supply (u64)
- **Byte 44**: decimals (u8) ← We read this
- Byte 45: is_initialized
- Bytes 46-81: freeze_authority

### 3. Reserve Cache Fallback Logic
**File**: `src/cache/reserveCache.ts`

Added comprehensive SPL Mint fallback in `loadReserves()`:

#### Step 1: Collect Missing Decimals
After decoding reserves, collect mint pubkeys where `liquidityDecimals === -1` or `collateralDecimals === -1`:
```typescript
const mintFallbackMap = new Map<string, { 
  type: "liquidity" | "collateral"; 
  reserves: Array<{ pubkey: PublicKey; decoded: DecodedReserve }> 
}>();

// Use Set for O(1) duplicate detection
const reservesAddedToMint = new Map<string, Set<string>>();

for (const { pubkey, decoded } of decodedReserves) {
  if (decoded.liquidityDecimals === -1) {
    // Queue liquidity mint for fallback
  }
  if (decoded.collateralDecimals === -1) {
    // Queue collateral mint for fallback
  }
}
```

#### Step 2: Batch Fetch Mint Accounts
Deduplicate and fetch all required mints in a single RPC call:
```typescript
const mintPubkeys = Array.from(mintFallbackMap.keys()).map(k => new PublicKey(k));
const mintAccounts = await connection.getMultipleAccountsInfo(mintPubkeys, "confirmed");
```

#### Step 3: Parse and Fill Decimals
For each mint account, parse decimals and update all reserves using that mint:
```typescript
const decimals = parseSplMintDecimals(mintAccount.data);
for (const { decoded } of fallbackInfo.reserves) {
  if (decoded.liquidityMint === mintKey && decoded.liquidityDecimals === -1) {
    decoded.liquidityDecimals = decimals;
  }
  if (decoded.collateralMint === mintKey && decoded.collateralDecimals === -1) {
    decoded.collateralDecimals = decimals;
  }
}
```

#### Step 4: Guard Cache Population
Skip reserves that still have missing decimals after fallback:
```typescript
if (decoded.liquidityDecimals < 0 || decoded.collateralDecimals < 0) {
  logger.warn({ reserve, liquidityDecimals, collateralDecimals },
    "Reserve still has missing decimals after SPL fallback, skipping cache entry");
  failedDecodeCount++;
  continue;
}
```

### 4. Exchange Rate Guards
**File**: `src/cache/reserveCache.ts`

Added early return in `computeExchangeRateUi()` when decimals are missing:
```typescript
function computeExchangeRateUi(decoded: DecodedReserve): number {
  if (decoded.liquidityDecimals < 0 || decoded.collateralDecimals < 0) {
    logger.warn({ reserve: decoded.reservePubkey },
      "Missing mint decimals; skipping exchange rate until fallback resolves");
    return 0;
  }
  // ... exchange rate computation ...
}
```

This prevents runtime exceptions from `10n ** -1n` operations.

### 5. Enhanced Error Logging
Improved error logging throughout to include:
- Full exception details (message, stack)
- Key reserve fields (decimals, amounts, rates)
- Clear warnings at each stage (decode, fallback, cache)

Example:
```typescript
catch (error) {
  logger.warn({
    reserve: decoded.reservePubkey,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    liquidityDecimals: decoded.liquidityDecimals,
    collateralDecimals: decoded.collateralDecimals,
    availableAmountRaw: decoded.availableAmountRaw,
    // ... other fields
  }, "Failed to compute exchange rate, defaulting to 0");
  return 0;
}
```

### 6. Failure Tracking
Added `failedDecodeCount` to track reserves that couldn't be cached:
```typescript
logger.info({
  decoded: decodedCount,
  matchedMarket: matchedCount,
  cached: cachedCount,
  failedDecodeCount,  // ← NEW metric
}, "Reserve cache loaded successfully");
```

## Testing

### Unit Tests
**File**: `src/__tests__/splMint.test.ts` (NEW)
- 8 comprehensive tests for `parseSplMintDecimals()`
- Tests valid decimals (0, 6, 9, 255)
- Tests edge cases (null, undefined, short buffers)

### Integration Tests
**File**: `src/__tests__/reserveCache.test.ts`
- Added 2 new tests for SPL Mint fallback behavior:
  1. Successfully fetch and resolve missing decimals
  2. Skip caching when fallback fails
- All 8 existing reserve cache tests continue to pass

### Full Test Suite
- ✅ 103 tests pass
- ✅ 0 security vulnerabilities (CodeQL scan)
- ✅ All ESLint checks pass
- ✅ TypeScript compilation successful

## Performance Optimizations
1. **Set-based duplicate detection**: Changed from O(n²) array search to O(1) Set lookup
2. **Batch fetching**: Single `getMultipleAccountsInfo()` call for all mints
3. **Early guards**: Skip exchange rate computation for invalid decimals before bigint operations

## Expected Impact
After deploying these changes, `npm run snapshot:scored` should exhibit:

### ✅ Fixed Behaviors
1. **No more empty error logs**: Instead of `"Failed to compute exchange rate ... error: {}"`, logs now include full exception details
2. **Reduced MISSING_EXCHANGE_RATE**: Reserves with missing IDL decimals now successfully use SPL Mint fallback
3. **Non-zero collateral values**: Obligations with deposits will show actual collateral amounts instead of 0
4. **Higher reserve cache hit rate**: Summary logs include `failedDecodeCount` showing how many reserves succeeded vs failed

### 📊 New Metrics
Reserve cache summary now includes:
```
{
  decoded: 150,           // Total decoded
  matchedMarket: 150,     // Matched target market
  cached: 145,            // Successfully cached
  failedDecodeCount: 5    // Failed after fallback (NEW)
}
```

## Files Changed
```
src/kamino/decode/reserveDecoder.ts  |   9 +-   (tolerant parseU8Like)
src/utils/splMint.ts                 |  28 ++++  (NEW - SPL parser)
src/cache/reserveCache.ts            | 313 ++++-  (fallback logic + guards)
src/__tests__/splMint.test.ts        |  66 ++++  (NEW - tests)
src/__tests__/reserveCache.test.ts   | 147 ++++  (integration tests)
```

**Total**: 490 insertions(+), 73 deletions(-)

## Migration Notes
- **Breaking changes**: None. Changes are fully backward compatible.
- **Deployment**: No special steps required. Deploy as normal.
- **Monitoring**: Watch for `failedDecodeCount` in reserve cache logs to identify problematic reserves.
- **Rollback**: Safe to revert if issues arise; previous behavior was to throw on missing decimals.

## Future Improvements
1. Cache parsed mint account decimals to avoid redundant fetches across reserve reloads
2. Add telemetry/metrics for fallback success rates
3. Consider fallback to Metaplex metadata if SPL Mint account is missing/invalid
