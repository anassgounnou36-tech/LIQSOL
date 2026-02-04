# Chain 3 Removal and Magnitude Sanity Check Implementation

## Overview
This PR removes Scope chain 3 from fallback selection paths and adds magnitude sanity checks to prevent accepting placeholder-like prices that collapse collateral valuations.

## Problem Statement
Recent scoring runs showed that many mints resolved to Scope chain 3, producing near-zero USD values (e.g., value = 1e12 with exponent = -18 → ~1e-6 USD). This collapsed collateral values and produced garbage liquidatable rankings.

**Root causes:**
- Chain 3 was treated as a primary fallback and cached as resolved
- No magnitude validation prevented accepting placeholder prices
- Cached chain 3 selection persisted across runs

## Changes Made

### 1. Removed Chain 3 from Fallback Paths

**File:** `src/cache/oracleCache.ts`

#### a) Curated Fallback Candidates (line 213-217)
```typescript
// BEFORE:
const FALLBACK_CHAIN_CANDIDATES = [
  0, 1, 2, 3, 10, 13, 18, ...
];

// AFTER:
const FALLBACK_CHAIN_CANDIDATES = [
  0, 1, 2, 10, 13, 18, ...  // Chain 3 removed
];
```

#### b) Primary Fallback Loop (line 364-375)
```typescript
// BEFORE:
for (const chain of [0, 3]) {
  // Try both chain 0 and 3 as primary fallbacks
}

// AFTER:
for (const chain of [0]) {
  // Only chain 0 remains as primary fallback
}
```

#### c) Skip Logic in Curated Scan (line 383-400)
```typescript
// BEFORE:
if (chains.includes(chain) || chain === 0 || chain === 3) continue;

// AFTER:
if (chains.includes(chain) || chain === 0) continue;
```

### 2. Strengthened Price Usability Checks

**File:** `src/cache/oracleCache.ts` (lines 225-243)

Added magnitude sanity checks to `isPriceUsable()` function:

```typescript
function isPriceUsable(priceData: OraclePriceData | null): boolean {
  if (!priceData) return false;
  if (priceData.price === 0n) return false;
  if (!Number.isFinite(priceData.exponent)) return false;

  // NEW: Reject absurd exponent ranges
  if (priceData.exponent < -30 || priceData.exponent > 10) return false;

  // NEW: Magnitude check without floats: log10(uiPrice) ≈ (digits - 1) + exponent
  const digits = priceData.price.toString().length;
  const approxLog10 = (digits - 1) + priceData.exponent;

  // NEW: Reject extremely tiny prices (e.g., ~1e-6 USD)
  if (approxLog10 < -4) return false; // uiPrice < 1e-4

  // NEW: Reject extremely huge prices (protect against overflow nonsense)
  if (approxLog10 > 7) return false; // uiPrice > 1e7

  return true;
}
```

**Key features:**
- No floating-point math (uses integer digit counting)
- Rejects prices < 0.0001 USD (e.g., placeholder ~1e-6 values)
- Rejects prices > 10,000,000 USD (overflow protection)
- Exponent range validation (-30 to 10)

### 3. Updated Tests

**File:** `src/__tests__/scopeFallback.test.ts`

#### a) Updated Existing Test (line 117-163)
```typescript
// BEFORE:
it("should use primary fallback chain 3 when chain 0 also fails", async () => {
  // ... setup ...
  expect(cache.has(mint1)).toBe(true);
  expect(price!.price).toBe(200000000n);
});

// AFTER:
it("should not use fallback chain 3; no price cached when configured chains and chain 0 fail", async () => {
  // ... setup ...
  expect(cache.has(mint1)).toBe(false); // Chain 3 now excluded
});
```

#### b) Updated Staleness Test (line 322-372)
Changed from using chain 3 to chain 1 (curated fallback):
```typescript
// BEFORE: Fresh price at chain 3
[3, { price: "200000000", exp: 8, timestamp: currentTimestamp }]

// AFTER: Fresh price at chain 1 (curated fallback)
[1, { price: "200000000", exp: 8, timestamp: currentTimestamp }]
```

#### c) Added New Magnitude Tests (3 new tests)
1. **Reject tiny prices:** Tests that ~1e-6 USD is rejected
2. **Reject huge prices:** Tests that > 1e7 USD is rejected  
3. **Accept reasonable prices:** Tests that ~$100 USD is accepted

## Test Results

### All Tests Pass ✓
```
Test Files  16 passed (16)
Tests       112 passed | 2 skipped | 4 todo (118)
```

**Breakdown:**
- 6 original Scope fallback tests (all passing)
- 3 new magnitude sanity check tests (all passing)
- 103 other existing tests (all passing)

### No Build Errors
- TypeScript compilation clean for modified files
- Linter found only pre-existing issues (not introduced by this PR)

## Expected Impact

### Before
- Many mints resolved to chain 3 with placeholder prices (~1e-6 USD)
- Collateral valuations collapsed to near-zero
- Chain 3 cached and persisted across runs
- Top risk lists showed garbage rankings

### After
- Chain 3 excluded from all fallback paths
- Placeholder prices rejected by magnitude checks
- Only valid prices within 1e-4 to 1e7 USD range accepted
- Collateral valuations based on real prices only
- Improved risk ranking accuracy

## Acceptance Criteria Met

✅ No more auto-resolving to Scope chain 3 as fallback  
✅ Magnitude checks prevent accepting placeholder small prices  
✅ Unit tests reflect removed chain 3 behavior and all pass  
✅ Top risk lists will no longer show universally tiny collateral  
✅ Pricing based on configured chains, chain 0 fallback, or curated candidates (excluding 3)

## Files Changed
- `src/cache/oracleCache.ts`: 32 lines changed (core logic)
- `src/__tests__/scopeFallback.test.ts`: 169 lines changed (tests)

Total: 2 files, 183 insertions, 18 deletions
