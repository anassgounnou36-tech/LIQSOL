# Exchange Rate and BigFraction Math Bug Fixes

## Problem Statement

Recent runs showed Top lists where Borrow Value was extremely large while Collateral Value was $0.00 or NaN. This indicated two critical math bugs:

1. **Inverted Exchange Rate Formula**: The collateral exchange-rate formula was inverted compared to KLend specification
2. **Invalid BigFraction Division**: Code was dividing `borrowedAmountSf` by `cumulativeBorrowRateBsf` treating it as an integer, causing division to floor to zero

## Root Causes

### 1. Exchange Rate Direction Bug

**Previous (Incorrect) Formula:**
```
exchangeRateUi = totalLiquidityUi / collateralSupplyUi
```

**Corrected Formula (per KLend spec):**
```
exchangeRateUi = collateralSupplyUi / totalLiquidityUi
```

The exchange rate represents how many collateral tokens are needed to back one unit of underlying liquidity. According to the [Certora KLend audit](https://www.certora.com/blog/securing-kamino-lending), the correct formula is `mintTotalSupply / totalLiquidity`.

### 2. BigFraction Division Bug

**Previous (Incorrect) Approach:**
```typescript
// Treated cumulativeBorrowRateBsf as a simple integer divisor
const borrowTokensRaw = borrowedAmountSf / cumulativeBorrowRateBsf;
```

**Issue:** `borrowedAmountSf` is already a scaled fraction (scaled by 1e18/WAD). Dividing by `cumulativeBorrowRateBsf` (also scaled) causes double-scaling and integer division often floors to zero, collapsing `totalLiquidity` and thereby the exchange rate.

**Corrected Approach:**
```typescript
// borrowedAmountSf is already scaled by 1e18, just divide by 1e18
const borrowRaw = borrowedAmountSf / (10n ** 18n);
```

## Changes Made

### 1. `src/cache/reserveCache.ts`

#### Function: `computeExchangeRateUi()`

**Key Changes:**
- Removed division by `cumulativeBorrowRateBsf` when computing `totalLiquidity`
- Use `borrowedAmountSf / 1e18` to convert scaled fraction to raw tokens
- Inverted exchange rate formula: `collateralSupplyUi / totalLiquidityUi`
- Simplified using UI unit division instead of complex bigint mul-div

**Before:**
```typescript
const borrowTokensRaw = borrowSf / cumRate;
const totalLiquidity = avail + borrowTokensRaw;
const num = totalLiquidity * (10n ** BigInt(decoded.collateralDecimals));
const den = supply * (10n ** BigInt(decoded.liquidityDecimals));
const rate = divBigintToNumber(num, den, 18);
```

**After:**
```typescript
const borrowRaw = borrowSfRaw / (10n ** 18n);
const totalLiquidityRaw = availRaw + borrowRaw;
const totalLiquidityUi = divBigintToNumber(totalLiquidityRaw, liquidityScale, liquidityDecimals);
const collateralSupplyUi = divBigintToNumber(supply, collateralScale, collateralDecimals);
const rate = collateralSupplyUi / totalLiquidityUi;
```

### 2. `src/math/health.ts`

#### Function: `convertBorrowSfToUi()`

**Key Changes:**
- Removed `cumulativeBorrowRateBsf` parameter
- Use `borrowedAmountSf / 1e18` to convert to raw tokens
- Removed invalid `MISSING_DEBT_RATE` check

**Before:**
```typescript
function convertBorrowSfToUi(
  borrowedAmountSf: string | undefined | null,
  cumulativeBorrowRateBsf: bigint,
  liquidityDecimals: number
): number {
  // ...
  const borrowedTokensRaw = borrowedSf / cumulativeBorrowRateBsf;
  // ...
}
```

**After:**
```typescript
function convertBorrowSfToUi(
  borrowedAmountSf: string | undefined | null,
  liquidityDecimals: number
): number {
  // ...
  const borrowedTokensRaw = borrowedSf / (10n ** 18n);
  // ...
}
```

#### Deposit Conversion

**Key Changes:**
- Changed from multiplying by exchange rate to dividing by exchange rate
- This accounts for the inverted exchange rate formula

**Before:**
```typescript
const depositUi = depositedNotesUi * exchangeRateUi;
```

**After:**
```typescript
// With corrected exchange rate (collateralSupply / totalLiquidity),
// divide to convert collateral to liquidity
const depositUi = depositedNotesUi / exchangeRateUi;
```

### 3. `src/commands/snapshotScoredObligations.ts`

**Key Changes:**
- Display "N/A" for zero values instead of "$0.00"
- Add console output for unscored obligations summary with reason breakdown
- Show percentages for each unscored reason

**Benefits:**
- Zero values no longer mask missing data
- Users can see why obligations couldn't be scored
- Better visibility into data quality issues

### 4. `src/kamino/types.ts`

**Minor Change:**
- Updated comment for `cumulativeBorrowRateBsfRaw` to clarify it's for reference only

## Testing

Added comprehensive tests to validate the fixes:

### Exchange Rate Tests (`src/__tests__/reserveCache.test.ts`)

1. **Test: 1:1 Exchange Rate**
   - Available: 1000 tokens
   - Borrowed: 500 tokens (scaled)
   - Collateral: 1500 tokens
   - Expected: `1500 / 1500 = 1.0` ✅

2. **Test: Exchange Rate > 1**
   - Available: 1000 tokens
   - Borrowed: 100 tokens (scaled)
   - Collateral: 1200 tokens
   - Expected: `1200 / 1100 = 1.0909` ✅

### Health Ratio Tests (`src/__tests__/health-ratio.test.ts`)

3. **Test: Deposit Conversion with Inverted Exchange Rate**
   - Deposited: 100 collateral tokens
   - Exchange Rate: 1.1
   - Expected underlying: `100 / 1.1 = 90.909` liquidity tokens
   - Expected collateral value: `90.909 * $1 * 0.95 = $86.36` ✅

### All Tests Pass ✅
- 115 tests pass
- No security vulnerabilities (CodeQL)

## Impact

### Before Fix
- Collateral values collapsed to $0.00 due to exchange rate math errors
- Borrow values extremely large relative to collateral
- Health ratios universally near-zero
- Many obligations incorrectly flagged as liquidatable

### After Fix
- Collateral values computed correctly using proper exchange rate
- Health ratios realistic and meaningful
- Proper identification of liquidatable positions
- Better data quality visibility through improved output

## References

1. [Certora KLend Security Audit](https://www.certora.com/blog/securing-kamino-lending) - Exchange rate specification
2. [Shyft Case Study](https://docs.shyft.to/solana-indexers/case-studies/kamino/get-borrow-details-of-a-wallet?utm_source=chatgpt.com) - Scaled fraction context

## Acceptance Criteria Met

✅ Collateral Value not zero for obligations with actual deposits  
✅ NaN values eliminated (replaced with N/A when appropriate)  
✅ Health ratios and liquidatable flags realistic  
✅ Exchange rate correctly implements KLend formula  
✅ All tests pass  
✅ No security vulnerabilities
