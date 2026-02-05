# Oracle Type Fix Summary

## Problem
Build was failing with TypeScript errors because test fixtures were missing the required `oracleType` field in `OraclePriceData` objects.

## Root Cause
The `OraclePriceData` interface was updated to require an `oracleType` field:
```typescript
export interface OraclePriceData {
  price: bigint;
  confidence: bigint;
  slot: bigint;
  exponent: number;
  oracleType: "pyth" | "switchboard" | "scope"; // ← Required field
}
```

However, test fixtures in two files were still using the old format without this field.

## Errors Fixed

### Before Fix
```
src/__tests__/health-breakdown.test.ts(62,11): error TS2322: Property 'oracleType' is missing
src/__tests__/health-breakdown.test.ts(167,11): error TS2322: Property 'oracleType' is missing
src/__tests__/health-breakdown.test.ts(226,11): error TS2322: Property 'oracleType' is missing
src/__tests__/health-breakdown.test.ts(299,11): error TS2322: Property 'oracleType' is missing
src/__tests__/health-breakdown.test.ts(346,24): error TS2345: Property 'oracleType' is missing
src/__tests__/pr8-alignment.test.ts(71,11): error TS2322: Property 'oracleType' is missing
src/__tests__/pr8-alignment.test.ts(190,11): error TS2322: Property 'oracleType' is missing
src/__tests__/pr8-alignment.test.ts(266,11): error TS2322: Property 'oracleType' is missing
src/__tests__/pr8-alignment.test.ts(359,11): error TS2322: Property 'oracleType' is missing
```

Total: **9 TypeScript errors**

### After Fix
```
0 oracleType-related errors
```

## Changes Applied

### File 1: `src/__tests__/health-breakdown.test.ts`
Fixed 5 oracle fixtures by adding `oracleType: "pyth"` to each:
- Line ~62: First prices map (SOL + USDC)
- Line ~167: Single SOL prices map
- Line ~226: OracleCache map
- Line ~299: Prices map in HR clamp test
- Line ~346: prices.set("USDC", ...) call

### File 2: `src/__tests__/pr8-alignment.test.ts`
Fixed 4 oracle fixtures by adding `oracleType: "pyth"` to each:
- Line ~71: First oracle cache (SOL + USDC)
- Line ~190: Second oracle cache (SOL only)
- Line ~266: Third oracle cache (SOL only)
- Line ~359: Fourth oracle cache (SOL + USDC)

## Example Change

### Before
```typescript
const prices: OracleCache = new Map([
  [
    "SOL",
    {
      price: 100000000000n,
      confidence: 1000000000n,
      exponent: -9,
      slot: 1000n,
      // ❌ Missing oracleType
    },
  ],
]);
```

### After
```typescript
const prices: OracleCache = new Map([
  [
    "SOL",
    {
      price: 100000000000n,
      confidence: 1000000000n,
      exponent: -9,
      slot: 1000n,
      oracleType: "pyth", // ✅ Added
    },
  ],
]);
```

## Verification
- ✅ Build passes without oracleType errors
- ✅ All 9 fixtures updated
- ✅ No functionality changes, only type compliance
- ✅ Used "pyth" as oracle type (most common in tests)

## Impact
- **Files changed:** 2 test files
- **Lines changed:** 12 lines (9 additions of `oracleType: "pyth",`)
- **Build errors fixed:** 9 TypeScript type errors
- **Functionality impact:** None (type-only fix)
