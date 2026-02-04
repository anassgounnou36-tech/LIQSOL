# Scope Pricing Resilience Implementation Summary

## Overview
This implementation adds resilient fallback chain search to the Scope oracle price decoder, making it able to automatically find valid prices even when configured chain indices are stale, misconfigured, or missing.

## Changes Made

### 1. Enhanced decodeScopePrice Function (`src/cache/oracleCache.ts`)

#### New Return Type
```typescript
interface ScopePriceResult {
  priceData: OraclePriceData | null;  // The decoded price, or null if none found
  winningChain?: number;               // The chain index that yielded the price
  triedFallbackScan: boolean;          // Whether fallback scanning was used
}
```

#### Fallback Chain Search Strategy
The decoder now tries chains in the following order:

1. **Configured chains** (from reserve configuration)
   - First tries the chains specified in the reserve's `scopePriceChain` array
   - These are the chains configured for this specific mint

2. **Primary fallback chains** [0, 3]
   - If configured chains fail, tries common fallback indices 0 and 3
   - These are the most commonly used chain indices across markets

3. **Curated candidate list scan**
   - If primary fallbacks also fail, scans a curated list of 43 commonly used chain indices:
   ```
   [0, 1, 2, 3, 10, 13, 18, 20, 22, 25, 50, 108, 112, 118, 119, 146, 148, 150, 175,
    202, 208, 210, 211, 212, 213, 214, 215, 216, 217, 219, 220, 221, 222, 223, 224,
    235, 246, 267, 311, 377, 426, 500, 507]
   ```
   - Stops at the first chain with a valid, fresh, non-zero price

4. **Returns null** if no valid price found after exhaustive search

#### Price Validation
Each chain candidate is validated against:
- Non-sentinel value (not 65535)
- Within valid range (0-511)
- Within oracle's available price array bounds
- Has non-null DatedPrice and Price objects
- Has positive, non-zero price value
- Has finite exponent
- Has non-zero timestamp
- Timestamp is fresh (within 30 seconds staleness threshold)

### 2. Resolved Chain Caching (`src/cache/oracleCache.ts`)

#### Cache Implementation
```typescript
const resolvedScopeChainByMint = new Map<string, number>();
```

When a fallback scan successfully finds a price at a specific chain index, that index is cached per mint. On subsequent loads, the cached chain is tried first (before configured chains).

#### Chain Precedence Order
```
1. Resolved chain (from cache, if fallback was previously used)
2. Configured chains (from reserve's scopePriceChain)
3. Override chains (from scopeChainOverrides map)
4. Fallback chains [0, 3]
5. Curated candidate scan
```

This ensures that once a working chain is found for a mint, it's used first in future loads.

### 3. Enhanced Logging

The implementation adds detailed diagnostic logging:

```typescript
// When configured chain works
logger.info({ chain, value, exponent }, "Scope price selected from configured chains");

// When fallback is used
logger.info({ 
  chain, value, exponent, configuredChains, scannedCandidates 
}, "Scope price selected from curated fallback candidate scan");

// When caching resolved chain
logger.info({ 
  mint, resolvedChain, originalChains 
}, "Cached resolved Scope chain for mint (found via fallback)");

// When all attempts fail
logger.warn({ 
  configuredChains, availablePrices, scannedCandidates 
}, "No usable Scope price found after trying configured chains and fallback scanning");
```

### 4. Comprehensive Test Coverage (`src/__tests__/scopeFallback.test.ts`)

Created 6 test cases covering:
1. ✅ Primary fallback chain 0 usage when configured chain fails
2. ✅ Primary fallback chain 3 usage when chain 0 also fails
3. ✅ Curated candidate scan when primary fallbacks fail
4. ✅ Null return when no valid price found after exhaustive search
5. ✅ Configured chain precedence over fallbacks
6. ✅ Stale price filtering during fallback scan

All tests pass successfully.

## Benefits

1. **Resilience**: System can recover from misconfigured or stale chain indices
2. **Auto-discovery**: Automatically finds valid chains without manual intervention
3. **Performance**: Caches resolved chains to avoid repeated scanning
4. **Transparency**: Detailed logging shows when fallbacks are used and why
5. **Backward Compatible**: Existing configurations continue to work, fallback only activates on failure
6. **Minimal Changes**: Surgical changes focused only on Scope oracle decoding

## Impact on MISSING_ORACLE_PRICE Errors

This implementation should significantly reduce MISSING_ORACLE_PRICE errors by:
- Finding valid prices even when configured chains are wrong
- Scanning alternative chains automatically
- Caching successful discoveries for future use
- Logging diagnostic information to help identify persistent issues

## Example Scenarios

### Scenario 1: Misconfigured Chain
- Reserve configured with chain 100 (doesn't exist in oracle)
- Decoder tries chain 100 → fails
- Decoder tries fallback chain 0 → succeeds ✅
- Chain 0 is cached for this mint
- Future loads try chain 0 first → immediate success

### Scenario 2: Stale Configuration
- Reserve configured with chain 50 (price is stale)
- Decoder tries chain 50 → stale, rejected
- Decoder scans candidates → finds chain 118 with fresh price ✅
- Chain 118 is cached for this mint
- Future loads try chain 118 first → immediate success

### Scenario 3: Multiple Mints, Same Oracle
- Mint A uses chain 10
- Mint B uses chain 20  
- Both use the same Scope oracle account
- Each mint gets decoded independently with its own chain configuration
- Each can have its own cached resolved chain
- No interference between mints ✅
