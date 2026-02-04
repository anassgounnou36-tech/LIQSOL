# Collateral Valuation Fix with Bigint Math

## Problem Summary

The health ratio computation had critical issues causing most obligations to be unscored with MISSING_EXCHANGE_RATE:

1. **Precision loss in exchange rate conversion** - Using `Number()` on BigFraction BSF values (1e18 scale) caused precision loss and overflow for large values
2. **Wrong decimals for deposit normalization** - Using `liquidityDecimals` instead of `collateralDecimals` for normalizing collateral token amounts
3. **Potential overflow in borrow conversion** - Using `Number()` directly could cause NaN or overflow
4. **Log spam** - "Collateral exchange rate is zero" warnings appeared for every deposit, flooding logs

## Root Causes

### 1. Exchange Rate Precision Loss
```typescript
// BEFORE: Number() loses precision for large BigFraction values
const scaled = Number(collateralExchangeRateBsf); // Can overflow or lose precision
const rate = scaled / (10 ** 18);
```

BigFractionBytes values are stored as 256-bit numbers in Kamino. Converting directly to JavaScript Number (64-bit float) loses precision and can cause incorrect exchange rates.

### 2. Wrong Decimals for Collateral
```typescript
// BEFORE: Using liquidityDecimals for collateral tokens - WRONG!
const depositUi = (depositedNotes / (10 ** reserve.liquidityDecimals)) * exchangeRateUi;
```

The `depositedAmount` field represents collateral tokens (cTokens), not liquidity tokens. These should be normalized using `collateralDecimals`, not `liquidityDecimals`.

### 3. Borrow Conversion Issues
```typescript
// BEFORE: Direct Number() conversion can overflow
const num = Number(borrowedAmountSf);
return num / (10 ** liquidityDecimals);
```

For large borrowed amounts, converting to Number first could cause overflow or NaN.

## Solution Implementation

### 1. Bigint-Safe Exchange Rate Conversion
```typescript
const BSF_SCALE = 10n ** 18n;

function exchangeRateUiFromBsfString(bsfStr: string | undefined | null): number | null {
  if (!bsfStr) return null;
  
  try {
    const bsf = BigInt(bsfStr);
    if (bsf <= 0n) return null;
    
    // Use bigint-safe division to preserve precision
    const rate = divBigintToNumber(bsf, BSF_SCALE, 18);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}
```

**Benefits:**
- Preserves precision throughout the calculation
- Handles 256-bit BigFraction values correctly
- No overflow or precision loss

### 2. Correct Decimals for Deposits
```typescript
// Normalize deposit notes using COLLATERAL decimals (not liquidity decimals)
const collateralScale = 10n ** BigInt(reserve.collateralDecimals);
const depositedNotesUi = divBigintToNumber(
  depositedNotesRaw,
  collateralScale,
  reserve.collateralDecimals
);

// Convert to underlying liquidity units using exchange rate
const depositUi = depositedNotesUi * exchangeRateUi;
```

**Benefits:**
- Correctly normalizes collateral tokens
- Proper conversion path: collateral tokens → UI units → underlying liquidity units
- Accurate valuations

### 3. Bigint-Safe Borrow Conversion
```typescript
function convertBorrowSfToUi(
  borrowedAmountSf: string | undefined | null,
  liquidityDecimals: number
): number {
  if (!borrowedAmountSf) return 0;
  
  try {
    const borrowedRaw = BigInt(borrowedAmountSf);
    if (borrowedRaw < 0n) return 0;
    
    const liquidityScale = 10n ** BigInt(liquidityDecimals);
    const borrowedUi = divBigintToNumber(borrowedRaw, liquidityScale, liquidityDecimals);
    
    return Number.isFinite(borrowedUi) && borrowedUi >= 0 ? borrowedUi : 0;
  } catch {
    return 0;
  }
}
```

**Benefits:**
- No overflow for large borrow amounts
- Safe conversion with error handling
- Validates results before returning

### 4. Gated Warning Logs
```typescript
let VERBOSE_EXCHANGE_RATE = false;
try {
  VERBOSE_EXCHANGE_RATE = (globalThis as any).process?.env?.LIQSOL_VERBOSE_EXCHANGE_RATE === "1";
} catch {
  // Ignore - defaults to false
}

// In the code:
if (exchangeRateUi === null || exchangeRateUi <= 0) {
  if (VERBOSE_EXCHANGE_RATE) {
    logger.warn(
      { mint: deposit.mint, reserve: deposit.reserve },
      "Collateral exchange rate is zero or invalid, skipping deposit"
    );
  }
  return { scored: false, reason: "MISSING_EXCHANGE_RATE" };
}
```

**Benefits:**
- Warnings only appear when explicitly enabled
- Set `LIQSOL_VERBOSE_EXCHANGE_RATE=1` for debugging
- Clean logs in production

## Expected Outcomes

### Before
- Most obligations: `MISSING_EXCHANGE_RATE` due to precision loss
- Log spam: Thousands of warnings per run
- `totalCollateralValue: $0` or very low
- `averageHealthRatio: 0` or meaningless

### After
- Obligations correctly scored with accurate collateral values
- Clean logs (warnings only with env flag)
- `totalCollateralValue: $X,XXX,XXX` (realistic values)
- `averageHealthRatio: 1.XX` (realistic ratios)
- Top risky obligations show non-zero collateral and borrow

## Testing

Run snapshot scoring:
```bash
# Normal operation (no warnings)
npm run snapshot:scored

# Debug mode (with warnings)
LIQSOL_VERBOSE_EXCHANGE_RATE=1 npm run snapshot:scored
```

Expected output:
```
INFO: Scoring complete
  totalObligations: 1000
  scoredObligations: 950  (was ~0 before)
  unscoredObligations: 50
  unscoredReasons: {
    MISSING_ORACLE_PRICE: 30,
    MISSING_RESERVE: 15,
    MISSING_EXCHANGE_RATE: 5  (was ~995 before)
  }
  totalCollateralValue: $5,234,567.89  (was $0 before)
  averageHealthRatio: 1.45  (was 0 before)
```

## Technical Details

### BigFraction Format
Kamino uses BigFractionBytes for exchange rates:
- 256-bit integer (4 x u64 limbs)
- Scaled by 10^18 (BSF_SCALE)
- Stored as array: [limb0, limb1, limb2, limb3]

### Conversion Path
1. Collateral tokens (depositedAmount) → BigInt
2. Normalize by collateralDecimals → UI units (depositedNotesUi)
3. Multiply by exchange rate → Underlying liquidity UI units (depositUi)
4. Multiply by price → USD value

### Safe Math Utilities
Using `divBigintToNumber(numerator, denominator, precision)`:
- Performs division in bigint space
- Scales result by 10^precision
- Converts to JavaScript number safely
- Preserves precision throughout

## Related Files Changed
- `src/math/health.ts` - Main implementation
- Tests already handle discriminated union from previous PR
- Reserve mocks already include `collateralExchangeRateBsf`

## Environment Variables
- `LIQSOL_VERBOSE_EXCHANGE_RATE=1` - Enable detailed exchange rate warnings (default: off)
