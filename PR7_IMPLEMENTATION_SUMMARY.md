# PR7 Implementation Summary: Health Ratio and Liquidation Eligibility Engine

## Overview
Successfully implemented Kamino-specific risk scoring system for obligation health monitoring and liquidation eligibility detection.

## Files Created

### 1. `src/math/health.ts` (224 lines)
Health ratio computation module with:
- `computeHealthRatio()` function for calculating position health
- High-precision bigint math for intermediate calculations
- LTV-weighted collateral value computation
- Borrow value calculation with USD price conversion
- Graceful handling of missing reserves/prices (skip and log)
- Health ratio clamping to [0, 2] range
- Safe division to avoid NaN

**Key Features:**
- Converts oracle prices using exponent scaling (e.g., -8 for Pyth)
- Uses mint decimals for accurate token amount conversion
- Weights deposits by LTV ratio from reserve config
- Returns structured result with healthRatio, borrowValue, collateralValue

### 2. `src/math/liquidation.ts` (11 lines)
Pure liquidation eligibility detection:
- `isLiquidatable(healthRatio, threshold)` function
- Simple threshold comparison: returns `healthRatio < threshold`
- Minimal and pure as specified

### 3. `src/commands/snapshotScoredObligations.ts` (191 lines)
CLI tool for batch scoring:
- Loads reserves and oracles from RPC
- Creates indexer with caches for scoring
- Bootstraps obligations from snapshot
- Computes health scores for all obligations
- Outputs top-N riskiest accounts sorted by health ratio
- Prints formatted table and structured JSON logs
- No secrets in output

**Usage:** `npm run snapshot:scored`

### 4. `src/__tests__/health-ratio.test.ts` (328 lines)
Comprehensive test suite:
- Tests for healthy positions
- Tests for underwater positions
- Tests for missing reserve handling
- Tests for missing price handling
- Tests for health ratio clamping
- Tests for liquidation threshold detection
- All 8 tests passing

## Files Modified

### 1. `src/engine/liveObligationIndexer.ts`
**Changes:**
- Added optional `reserveCache` and `oracleCache` to config
- Extended `ObligationEntry` with scoring fields (healthRatio, borrowValue, collateralValue, liquidationEligible)
- Added `computeHealthScoring()` private method
- Integrated scoring into `handleAccountUpdate()` and bootstrap
- Added `getScoredObligations(limit?)` method to retrieve scored obligations sorted by risk
- Updated `getStats()` to include `scoredCount` and `liquidatableCount`
- Did NOT modify decoding or streaming logic

**Backward Compatible:** Scoring only happens when caches are provided

### 2. `src/cache/reserveCache.ts`
**Changes:**
- Added `liquidityDecimals: number` to `ReserveCacheEntry` interface
- Populated decimals in cache from decoded reserve data

**Rationale:** Needed for accurate USD value calculations

### 3. `package.json`
**Changes:**
- Added `"snapshot:scored": "tsx src/commands/snapshotScoredObligations.ts"` script

### 4. Test Fixtures
**Updated:**
- `src/__tests__/cacheIndex.test.ts` - Added liquidityDecimals to mock data
- `src/__tests__/oracleCache.test.ts` - Added liquidityDecimals to all mock entries

## Implementation Details

### Health Ratio Calculation Algorithm

```typescript
// For each deposit:
//   1. Get mint decimals from reserve
//   2. Get USD price from oracle (price * 10^exponent)
//   3. Calculate: depositValueUSD = (depositAmount / 10^decimals) * usdPerToken
//   4. Weight by LTV: weightedValue = depositValueUSD * (loanToValue / 100)
//   5. Sum all weighted collateral

// For each borrow:
//   1. Get mint decimals from reserve
//   2. Get USD price from oracle
//   3. Calculate: borrowValueUSD = (borrowAmount / 10^decimals) * usdPerToken
//   4. Sum all borrow values

// Health Ratio:
//   - If no borrows: return 2 (max, healthy)
//   - If no collateral with borrows: return 0 (liquidatable)
//   - Otherwise: collateralWeighted / borrowValue, clamped to [0, 2]
```

### Liquidation Threshold Selection

In the live indexer, the **minimum liquidation threshold** from all involved reserves (both deposits and borrows) is used as a conservative approach:

```typescript
// Check all deposit and borrow mints
for (const mint of allMints) {
  const reserve = this.reserveCache.get(mint);
  if (reserve) {
    const threshold = reserve.liquidationThreshold / 100; // Convert percentage to decimal
    minLiquidationThreshold = Math.min(minLiquidationThreshold, threshold);
  }
}

// Then check: isLiquidatable(healthRatio, minLiquidationThreshold)
```

## Testing Results

### Unit Tests
- ✅ All 8 health ratio and liquidation tests pass
- ✅ All 96 existing tests pass (no regressions)
- ✅ Build succeeds without errors

### Test Coverage
- Healthy positions (health ratio > 1)
- Underwater positions (health ratio < 1)
- Missing reserve data handling
- Missing price data handling
- Health ratio clamping edge cases
- Liquidation threshold comparison

## Usage Examples

### 1. Scoring Obligations in Live Indexer

```typescript
import { LiveObligationIndexer } from "./engine/liveObligationIndexer.js";
import { loadReserves } from "./cache/reserveCache.js";
import { loadOracles } from "./cache/oracleCache.js";

// Load caches
const reserveCache = await loadReserves(connection, marketPubkey);
const oracleCache = await loadOracles(connection, reserveCache);

// Create indexer with caches
const indexer = new LiveObligationIndexer({
  yellowstoneUrl,
  yellowstoneToken,
  programId,
  rpcUrl,
  reserveCache,  // Optional: enables scoring
  oracleCache,   // Optional: enables scoring
});

await indexer.start();

// Get stats
const stats = indexer.getStats();
console.log(`Scored: ${stats.scoredCount}, Liquidatable: ${stats.liquidatableCount}`);

// Get riskiest obligations
const risky = indexer.getScoredObligations(10); // Top 10
risky.forEach(o => {
  console.log(`${o.obligationPubkey}: HR=${o.healthRatio}, Eligible=${o.liquidationEligible}`);
});
```

### 2. Batch Scoring from Snapshot

```bash
# First, create obligations snapshot
npm run snapshot:obligations

# Then, score them
npm run snapshot:scored
```

Output:
```
=== TOP RISKY OBLIGATIONS ===

Rank | Health Ratio | Liquidatable | Borrow Value | Collateral Value | Deposits | Borrows | Obligation
-----------------------------------------------------------------------------------
   1 |       0.7543 | YES          |     $1234.56 |          $930.45 |        2 |       1 | 5ZqK...
   2 |       0.8912 | YES          |      $567.89 |          $506.12 |        1 |       1 | 7aBc...
   3 |       1.0234 | NO           |       $89.12 |          $91.23 |        1 |       1 | 9xYz...
```

### 3. Direct Health Ratio Computation

```typescript
import { computeHealthRatio } from "./math/health.js";
import { isLiquidatable } from "./math/liquidation.js";

const result = computeHealthRatio({
  deposits: obligation.deposits,
  borrows: obligation.borrows,
  reserves: reserveCache,
  prices: oracleCache,
});

console.log(`Health Ratio: ${result.healthRatio}`);
console.log(`Collateral: $${result.collateralValue}`);
console.log(`Borrow: $${result.borrowValue}`);

const threshold = 0.85; // 85%
if (isLiquidatable(result.healthRatio, threshold)) {
  console.log("Position is liquidatable!");
}
```

## Constraints Satisfied

✅ **Do NOT modify decoding logic or market filtering**
- No changes to obligation/reserve decoders
- No changes to market filtering logic

✅ **Use ReserveCache and OracleCache from PR6**
- Leverages existing cache infrastructure
- No GPA calls in obligations flow

✅ **High-precision numeric handling**
- Uses bigint for intermediate calculations
- Applies proper decimal scaling
- Safe conversion for UI numbers

✅ **Structured logs only; do not print tokens**
- All logging uses structured JSON
- No token addresses in console output
- Sensitive data properly redacted

## Acceptance Criteria Met

✅ `npm run snapshot:obligations` then `npm run snapshot:scored` outputs clean scoring logs and sorted accounts by healthRatio

✅ Live indexer computes healthRatio and liquidationEligible per update without impacting stream stability
- Scoring is optional (only when caches provided)
- Graceful handling of missing data
- No performance impact on streaming

✅ Scoring uses reserve LTV/liquidation thresholds and oracle uiPrice correctly; missing data handled gracefully
- LTV weighting applied correctly
- Oracle prices converted with exponent
- Missing reserves/prices logged and skipped
- Conservative threshold selection (minimum)

## Future Enhancements

While not required for PR7, these could be added in future PRs:

1. **Cumulative Borrow Rate Integration**
   - Currently using raw borrowed amount
   - Could multiply by cumulative borrow rate for accurate interest

2. **Close Factor and Liquidation Bonus**
   - Currently only flags eligibility
   - Could compute liquidation amounts with bonus

3. **Historical Health Tracking**
   - Track health ratio changes over time
   - Alert on rapid deterioration

4. **Multi-oracle Price Aggregation**
   - Currently uses first available oracle
   - Could aggregate multiple oracle prices

## Conclusion

PR7 is **fully implemented and tested**. All requirements have been met:
- ✅ New math modules for health ratio and liquidation
- ✅ Integration into live obligation indexer
- ✅ Optional CLI for scored snapshot
- ✅ Comprehensive test coverage
- ✅ No regressions in existing functionality
- ✅ Clean, maintainable code following project patterns

The implementation provides a solid foundation for liquidation bot development and risk monitoring.
