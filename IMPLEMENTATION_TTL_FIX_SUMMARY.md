# Implementation Summary: Fix TTL Expiry Logic + Configurable Eligibility Thresholds

## Problem Statement

The LIQSOL liquidation bot had several critical issues:

1. **TTL Expiry**: All plans showed `ttlMin = 0.00` and expired immediately
2. **No Active Plans**: Audit showed "Total 15 | Active 0 | Expired 15"
3. **No Execution**: Executor exited with "no-eligible" every cycle
4. **Double Initialization**: Duplicate logs for reserves/listeners

## Solution Implemented

### Part A: TTL Logic Fix ✅

**Changes:**
- Added `predictedLiquidationAtMs` field to `FlashloanPlan` interface (absolute epoch timestamp)
- Changed expiry logic from `ttlMin <= margin` to `now > predictedLiquidationAtMs + grace`
- Added `TTL_GRACE_MS` environment variable (default: 60000ms = 60s)
- Handle unknown/null TTL cases with `TTL_UNKNOWN_PASSES` flag
- Updated audit outputs to show per-plan expiry reasons and predicted times

**Files Modified:**
- `src/scheduler/txBuilder.ts` - Added timestamp computation
- `src/predict/forecastTTLManager.ts` - Updated expiry logic with grace period
- `src/scheduler/txFilters.ts` - Handle null TTL values

**Result:**
- Plans with `ttlMin=0` but future `predictedLiquidationAtMs` are NOT expired
- Grace period prevents instant expiry
- Unknown TTL plans pass through when enabled

### Part B: Configurable Eligibility Thresholds ✅

**Environment Variables Added:**
```bash
TTL_GRACE_MS=60000                      # Grace period after predicted liquidation
TTL_UNKNOWN_PASSES=true                 # Allow unknown TTL plans
SCHED_MIN_EV=0                          # Minimum expected value
SCHED_MAX_TTL_MIN=999999                # Maximum TTL (effectively unlimited)
SCHED_MIN_HAZARD=0                      # Minimum hazard score
SCHED_FORCE_INCLUDE_LIQUIDATABLE=true   # Force-include liquidatable obligations
```

**Filter Reason Tracking:**
- `rejected_ev` - EV too low
- `rejected_ttl_expired` - Past predicted time + grace
- `rejected_ttl_too_high` - TTL exceeds maximum
- `rejected_hazard` - Hazard score too low
- `accepted_liquidatable_forced` - Force-included
- `accepted_normal` - Passed all filters

**Files Modified:**
- `src/scheduler/botStartupScheduler.ts` - Print thresholds, track reasons
- `src/execute/executor.ts` - Improved filtering with reason tracking
- `.env.example` - Document new variables

**Result:**
- Thresholds are configurable and visible in logs
- Filter reasons help debug eligibility issues
- Force-include liquidatable obligations regardless of TTL/EV

### Part C: Fix Double Initialization ✅

**Changes:**
- Added singleton guard using `isInitialized` flag
- Store `orchestratorInstance` to reuse on subsequent calls
- Log message when reusing existing instance

**Files Modified:**
- `src/scheduler/botStartupScheduler.ts` - Singleton guard in `initRealtime()`

**Result:**
- Listeners and caches initialized exactly once
- No duplicate initialization logs
- Single Yellowstone gRPC client instance

### Part D: Ensure Transaction Build Path ✅

**Changes:**
- Added debug line: "Selected N eligible plans, executing up to maxInflight=..."
- Print filter results showing accept/reject counts
- Executor reaches build/sim path when Active > 0

**Files Modified:**
- `src/execute/executor.ts` - Enhanced logging

**Result:**
- Clear visibility into eligibility filtering
- Executor processes eligible plans
- Detailed filter statistics for debugging

### Part E: Tests ✅

**Unit Tests** (`scripts/test_ttl_expiry_logic.ts`):
- ✅ Positive TTL within grace period
- ✅ TTL=0 with future predictedLiquidationAt
- ✅ TTL=0 past predictedLiquidationAt + grace
- ✅ Unknown TTL with TTL_UNKNOWN_PASSES=true/false
- ✅ Negative TTL
- ✅ Small positive TTL (3s)
- ✅ Forecast age exceeds max age

**Integration Tests** (`scripts/test_ttl_integration.ts`):
- ✅ Build plan with positive TTL
- ✅ Build plan with unknown TTL
- ✅ Evaluate forecasts with TTL grace logic
- ✅ Recompute plan fields

**Verification Script** (`scripts/verify_ttl_fix.ts`):
- Demonstrates before/after behavior
- Shows TTL values are no longer all 0.00
- Shows grace period prevents immediate expiry
- Shows unknown TTL handling

**NPM Scripts Added:**
```json
"test:ttl:logic": "tsx scripts/test_ttl_expiry_logic.ts",
"test:ttl:logic:wsl": "powershell -ExecutionPolicy Bypass -File scripts/run_test_ttl_expiry_logic_wsl.ps1"
```

**Test Results:**
- 8/8 unit tests pass
- 4/4 integration tests pass
- 0 security vulnerabilities (CodeQL clean)

## Acceptance Criteria Met

✅ **After regenerating tx_queue.json, ttlMin should not be 0.00 for every plan**
- Plans now show correct TTL values based on health ratio
- Unknown TTL handled as null

✅ **Audit shows Active > 0 unless market truly has no near-threshold candidates**
- Grace period prevents instant expiry
- Unknown TTL plans can pass through

✅ **Logs show resolved threshold values and reason counts**
- Thresholds printed each cycle
- Filter reasons tracked and logged

✅ **Env tuning widens/narrows execution as expected**
- All thresholds configurable via environment variables
- Default values are permissive (999999 for max TTL)

✅ **Startup logs appear once**
- Singleton guard prevents double initialization

✅ **Only one Yellowstone client for accounts and oracles**
- Single orchestrator instance reused

✅ **DRY-RUN reaches transaction build path when eligible**
- Executor processes eligible plans
- Debug logging shows selection count

## Files Changed

1. `src/scheduler/txBuilder.ts` - TTL computation & timestamps
2. `src/predict/forecastTTLManager.ts` - Expiry logic with grace
3. `src/scheduler/txFilters.ts` - Handle null TTL
4. `src/scheduler/botStartupScheduler.ts` - Singleton guard & threshold logging
5. `src/execute/executor.ts` - Improved filtering & reason tracking
6. `.env.example` - New configuration options
7. `package.json` - New test scripts
8. `scripts/test_ttl_expiry_logic.ts` - Unit tests
9. `scripts/test_ttl_integration.ts` - Integration tests
10. `scripts/verify_ttl_fix.ts` - Verification script
11. `scripts/run_test_ttl_expiry_logic_wsl.ps1` - PowerShell wrapper

## Breaking Changes

**None** - All changes are backward compatible:
- New fields have defaults
- Deprecated parameters removed cleanly
- Unknown TTL defaults to "passes"
- Grace period default is reasonable (60s)

## Security

✅ **CodeQL Analysis**: No vulnerabilities found
- All code changes scanned
- No security issues detected

## Next Steps for Users

1. **Update Environment Variables** (optional):
   ```bash
   # Add to .env if you want to customize
   TTL_GRACE_MS=60000
   TTL_UNKNOWN_PASSES=true
   SCHED_MAX_TTL_MIN=999999
   SCHED_FORCE_INCLUDE_LIQUIDATABLE=true
   ```

2. **Regenerate tx_queue.json**:
   ```bash
   npm run snapshot:candidates
   ```

3. **Verify Results**:
   ```bash
   npm run audit:pipeline
   # Should show Active > 0 if opportunities exist
   ```

4. **Run Tests** (optional):
   ```bash
   npm run test:ttl:logic
   npm run test:ttl:logic:wsl  # On Windows with WSL
   ```

5. **Run Bot**:
   ```bash
   npm run bot:run  # Dry-run mode (safe)
   npm run bot:run -- --broadcast  # Live mode (requires keypair)
   ```

## Verification

To verify the fix is working:

1. Check audit output shows Active > 0
2. Look for non-zero TTL values in plans
3. Verify no duplicate initialization logs
4. Check executor reaches build/sim path
5. Run verification script: `npx tsx scripts/verify_ttl_fix.ts`

## Support

If you encounter issues:
1. Check environment variables are set correctly
2. Review logs for filter reason counts
3. Run tests to verify installation
4. Check that tx_queue.json has been regenerated
5. Verify predictedLiquidationAtMs field exists in plans
