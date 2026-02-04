# Build and Test Fixes for Discriminated Union HealthRatioResult

## Problem
After implementing the discriminated union pattern for `HealthRatioResult` in PR #21, the build had several issues:
1. TypeScript errors (TS2339) - Tests trying to access properties that only exist on the scored variant
2. Unused import warnings (TS6133) - `logger` and `divBigintToNumber` not used in health.ts
3. Unused constant - `FLOATING_POINT_TOLERANCE` not used
4. Unused parameter - `liquidityDecimals` in `parseExchangeRateUi` function

## Changes Made

### 1. src/math/health.ts
**Removed unused imports:**
```typescript
// Removed:
// import { logger } from "../observability/logger.js";
// import { divBigintToNumber } from "../utils/bn.js";
```

**Removed unused constant:**
```typescript
// Removed:
// const FLOATING_POINT_TOLERANCE = 1e-18;
```

**Simplified parseExchangeRateUi function:**
```typescript
// Before:
function parseExchangeRateUi(
  collateralExchangeRateBsf: string | undefined | null,
  liquidityDecimals: number  // <-- unused parameter
): number | null

// After:
function parseExchangeRateUi(
  collateralExchangeRateBsf: string | undefined | null
): number | null
```

**Updated call site:**
```typescript
// Before:
const exchangeRateUi = parseExchangeRateUi(
  reserve.collateralExchangeRateBsf.toString(),
  reserve.liquidityDecimals  // <-- removed
);

// After:
const exchangeRateUi = parseExchangeRateUi(
  reserve.collateralExchangeRateBsf.toString()
);
```

### 2. src/__tests__/health-ratio.test.ts

**Added helper type and function:**
```typescript
// Helper type and function to work with discriminated union
type Scored = Extract<HealthRatioResult, { scored: true }>;

function expectScored(result: HealthRatioResult): Scored {
  expect(result.scored).toBe(true);
  return result as Scored;
}
```

**Updated test cases to handle discriminated union:**

1. **"should compute health ratio correctly for healthy position"**
   ```typescript
   // Before:
   expect(result.collateralValue).toBeCloseTo(84.9915, 2);
   
   // After:
   const scored = expectScored(result);
   expect(scored.collateralValue).toBeCloseTo(84.9915, 2);
   ```

2. **"should handle missing reserve gracefully"**
   ```typescript
   // Before:
   expect(result.collateralValue).toBe(0);
   expect(result.borrowValue).toBe(0);
   expect(result.healthRatio).toBe(2);
   
   // After:
   expect(result.scored).toBe(false);
   if (!result.scored) {
     expect(result.reason).toBe("MISSING_RESERVE");
   }
   ```

3. **"should handle missing price gracefully"**
   ```typescript
   // Before:
   expect(result.collateralValue).toBe(0);
   expect(result.borrowValue).toBe(0);
   expect(result.healthRatio).toBe(2);
   
   // After:
   expect(result.scored).toBe(false);
   if (!result.scored) {
     expect(result.reason).toBe("MISSING_ORACLE_PRICE");
   }
   ```

4. **"should clamp health ratio to [0, 2]"**
   ```typescript
   // Before:
   expect(result.healthRatio).toBe(2);
   
   // After:
   const scored = expectScored(result);
   expect(scored.healthRatio).toBe(2);
   ```

5. **"should return 0 health ratio for underwater position"**
   ```typescript
   // Before:
   expect(result.collateralValue).toBeCloseTo(29.997, 1);
   
   // After:
   const scored = expectScored(result);
   expect(scored.collateralValue).toBeCloseTo(29.997, 1);
   ```

## Results

✅ **TS2339 errors resolved** - All property access errors on HealthRatioResult fixed
✅ **TS6133 warnings resolved** - All unused import/constant warnings removed
✅ **Type safety improved** - Tests now properly narrow the discriminated union
✅ **Semantics correct** - Tests for missing data now assert unscored state with reason

## Type Safety Benefits

The discriminated union pattern provides:
1. **Compile-time safety** - Cannot access scored properties without checking `scored: true`
2. **Clear intent** - Explicit distinction between scored and unscored results
3. **Better error handling** - Specific reasons for unscored obligations
4. **Runtime guarantees** - TypeScript ensures correct property access

## Testing Pattern

**For scored results:**
```typescript
const result = computeHealthRatio(input);
const scored = expectScored(result); // Type-safe narrowing
expect(scored.healthRatio).toBe(...);
expect(scored.collateralValue).toBe(...);
```

**For unscored results:**
```typescript
const result = computeHealthRatio(input);
expect(result.scored).toBe(false);
if (!result.scored) {
  expect(result.reason).toBe("MISSING_RESERVE");
}
```

This pattern prevents accidental access to properties that don't exist and makes test intent clearer.
