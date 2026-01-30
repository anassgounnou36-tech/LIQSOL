# Cache Usage Guide for Liquidation Scoring (PR7+)

## Overview

This guide provides best practices for using the Reserve and Oracle caches in liquidation scoring and bot operations. The caches are designed to be fast and efficient, but proper error handling is critical for production stability.

## Problem: Missing Cache Entries

Some obligations may use mints that aren't in the `ReserveCache`:

- **Native SOL** (`So11111111111111111111111111111111111111112`) 
- **Wrapped SOL** in different forms
- **New tokens** added after cache initialization
- **Delisted tokens** from old obligations
- **Oracle failures** for certain assets

## Critical: Never Crash on Missing Cache

❌ **WRONG - This will crash the bot:**

```typescript
const reserve = reserveCache.get(deposit.mint.toBase58());
if (!reserve) {
  throw new Error(`Missing reserve for mint ${deposit.mint.toBase58()}`);
}

const oracle = oracleCache.get(deposit.mint.toBase58());
const price = oracle.price; // Will crash if oracle is undefined!
```

✅ **CORRECT - Graceful handling:**

```typescript
// Check reserve exists
const reserve = reserveCache.get(deposit.mint.toBase58());
if (!reserve) {
  logger.warn(
    { mint: deposit.mint.toBase58(), obligation: obligationPubkey },
    "Skipping obligation: No reserve for mint"
  );
  continue; // Skip this obligation, don't crash
}

// Check oracle exists
const oracle = oracleCache.get(deposit.mint.toBase58());
if (!oracle) {
  logger.warn(
    { mint: deposit.mint.toBase58(), obligation: obligationPubkey },
    "Skipping obligation: No oracle price for mint"
  );
  continue; // Skip this obligation, don't crash
}

// Now safe to use reserve and oracle
const price = Number(oracle.price) / Math.pow(10, -oracle.exponent);
```

## Pattern: Processing All Obligations

When scoring all obligations in the cache:

```typescript
async function scoreAllObligations(
  obligations: DecodedObligation[],
  reserveCache: ReserveCache,
  oracleCache: OracleCache
): Promise<LiquidationScore[]> {
  const scores: LiquidationScore[] = [];
  
  for (const obligation of obligations) {
    try {
      const score = await scoreObligation(obligation, reserveCache, oracleCache);
      if (score) {
        scores.push(score);
      }
    } catch (err) {
      logger.warn(
        { obligation: obligation.obligationPubkey, error: err },
        "Failed to score obligation, skipping"
      );
      // Continue to next obligation
    }
  }
  
  return scores;
}

async function scoreObligation(
  obligation: DecodedObligation,
  reserveCache: ReserveCache,
  oracleCache: OracleCache
): Promise<LiquidationScore | null> {
  let totalCollateralValue = 0;
  let totalBorrowValue = 0;
  
  // Process deposits (collateral)
  for (const deposit of obligation.deposits) {
    const reserve = reserveCache.get(deposit.mint);
    if (!reserve) {
      logger.debug(
        { mint: deposit.mint, obligation: obligation.obligationPubkey },
        "Skipping deposit: No reserve"
      );
      return null; // Can't score without all data
    }
    
    const oracle = oracleCache.get(deposit.mint);
    if (!oracle) {
      logger.debug(
        { mint: deposit.mint, obligation: obligation.obligationPubkey },
        "Skipping deposit: No oracle"
      );
      return null; // Can't score without all data
    }
    
    const price = Number(oracle.price) / Math.pow(10, -oracle.exponent);
    const amount = BigInt(deposit.depositedAmount);
    totalCollateralValue += Number(amount) * price;
  }
  
  // Process borrows (debt)
  for (const borrow of obligation.borrows) {
    const reserve = reserveCache.get(borrow.mint);
    if (!reserve) {
      logger.debug(
        { mint: borrow.mint, obligation: obligation.obligationPubkey },
        "Skipping borrow: No reserve"
      );
      return null; // Can't score without all data
    }
    
    const oracle = oracleCache.get(borrow.mint);
    if (!oracle) {
      logger.debug(
        { mint: borrow.mint, obligation: obligation.obligationPubkey },
        "Skipping borrow: No oracle"
      );
      return null; // Can't score without all data
    }
    
    const price = Number(oracle.price) / Math.pow(10, -oracle.exponent);
    const amount = BigInt(borrow.borrowedAmount);
    totalBorrowValue += Number(amount) * price;
  }
  
  // Calculate health ratio
  const healthRatio = totalCollateralValue / totalBorrowValue;
  
  return {
    obligationPubkey: obligation.obligationPubkey,
    healthRatio,
    totalCollateralValue,
    totalBorrowValue,
    isLiquidatable: healthRatio < 1.0,
  };
}
```

## Debugging: Check Cache Coverage

At startup, log cache coverage:

```typescript
const { reserves, oracles } = await loadMarketCaches(connection, marketPubkey);

// Already logged by loadMarketCaches():
// - "Loaded reserve mints (showing first 10)"
// - "Loaded oracle mints (showing first 10)"

// Additional diagnostics if needed:
logger.info({ 
  reserveCount: reserves.size,
  oracleCount: oracles.size,
  reserveMints: Array.from(reserves.keys()),
  oracleMints: Array.from(oracles.keys())
}, "Full cache coverage");
```

## Common Edge Cases

### 1. Native SOL (So111...)

Native SOL may not have a direct reserve entry. Check if wrapped SOL (EPjF...) can be used instead, or skip obligations with native SOL.

### 2. Oracle Stale/Missing

If `oracle.slot` is very old compared to current slot, the price may be stale. Consider skipping or adding staleness checks.

### 3. Multiple Oracles per Mint

If a mint has multiple oracles (Pyth + Switchboard), the cache stores the last one processed. See `oracleCache.ts` for details.

### 4. Zero Prices

Check for `oracle.price === 0n` which indicates invalid/missing price data:

```typescript
if (oracle.price === 0n) {
  logger.warn({ mint }, "Oracle has zero price, skipping");
  continue;
}
```

## Testing

Always test with:
1. **Normal obligations** - common mints (USDC, SOL, etc.)
2. **Edge case obligations** - rare tokens, native SOL
3. **Empty caches** - ensure graceful degradation
4. **Partial caches** - some mints missing

## Summary

✅ **Always check for undefined before using cache entries**  
✅ **Log warnings and skip, never crash**  
✅ **Use try-catch around scoring logic**  
✅ **Test with edge case obligations**  

❌ **Never assume all mints are in cache**  
❌ **Never throw errors for missing cache entries**  
❌ **Never access properties without null checks**
