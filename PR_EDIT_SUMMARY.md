# PR Edit - Required Production Safety Fixes

## Summary

This PR edit implements two critical production safety fixes for the live obligation indexer:

1. **Auto-injection of obligation discriminator filter** - Prevents subscribing to all Kamino program accounts
2. **Outbound ping loop** - Prevents silent disconnects in long-running production processes

## Changes Made

### File 1: `src/engine/liveObligationIndexer.ts`

**Problem**: The indexer allowed subscribing with `filters: []` or `undefined`, which would subscribe to **all Kamino program accounts** - a dangerous and incorrect behavior for a liquidation bot.

**Solution**: Auto-inject the obligation discriminator filter if filters are empty or undefined.

**Implementation**:
- Added import: `import { anchorDiscriminator } from "../kamino/decode/discriminator.js";`
- In `start()` method, before loading snapshot:
  - Check if `this.config.filters` is `undefined` or an empty array
  - If so, calculate obligation discriminator: `anchorDiscriminator("Obligation")`
  - Inject filter with exact same logic as `snapshotObligations.ts`:
    ```typescript
    this.config.filters = [
      {
        memcmp: {
          offset: 0, // MUST be number for u64
          base64: obligationDiscriminator.toString("base64"),
        },
      },
    ] as any; // Type assertion for gRPC compatibility
    ```
  - Log the injection with discriminator hex value

**Why in the indexer (not the command)**:
- Indexer must be safe **by default**, even if instantiated from another runtime
- Command should not be responsible for safety logic
- Library hygiene principle

### File 2: `src/yellowstone/subscribeAccounts.ts`

**Problem**: The Yellowstone subscription listened for incoming pings and had an inactivity watchdog, but **did not actively send pings**, which can cause silent disconnects in long-running production processes.

**Solution**: Add outbound ping loop to actively maintain the connection.

**Implementation**:
- Added `pingIntervalId` variable to track the interval timer
- Created `clearPingInterval()` helper function
- Set up outbound ping loop immediately after creating the stream:
  ```typescript
  pingIntervalId = setInterval(() => {
    if (isClosed) return;
    try {
      stream.write({ ping: {} });
      logger.debug("Sent outbound ping to Yellowstone gRPC");
    } catch (err) {
      logger.warn({ err }, "Failed to send outbound ping");
    }
  }, 5000); // 5 seconds
  ```
- Added `clearPingInterval()` calls in all cleanup paths:
  - `close()` method of handle
  - `error` event handler
  - `end` event handler
  - `close` event handler

**Lifecycle Management**:
- Ping loop starts immediately after stream creation
- Inactivity watchdog and ping loop work independently
- Both timers are properly cleaned up on shutdown/error
- No timer leaks or resource issues

## Testing

### Existing Tests
- All 66 existing tests pass (2 skipped as before)
- No test failures or regressions

### New Tests
Added 4 comprehensive tests in `src/__tests__/auto-inject-discriminator.test.ts`:

1. **Auto-inject when filters is undefined**
   - Verifies filter is injected when config has `filters: undefined`
   - Checks filter structure and properties

2. **Auto-inject when filters is empty array**
   - Verifies filter is injected when config has `filters: []`
   - Ensures empty filters don't bypass safety

3. **Do NOT inject when filters are provided**
   - Verifies custom filters are preserved
   - Ensures no accidental override

4. **Verify correct discriminator bytes**
   - Calculates expected discriminator value
   - Verifies injected filter matches expected bytes
   - Ensures consistency with snapshot command

### Test Results
```
Test Files  10 passed (10)
Tests  70 passed | 2 skipped (72)
```

## Acceptance Checklist ✅

All acceptance criteria from the problem statement are met:

- [x] **Live indexer cannot subscribe without an obligation discriminator filter**
  - Auto-injection ensures filters are never empty
  - Tests verify injection behavior in all scenarios

- [x] **Yellowstone stream sends outbound pings every ~5 seconds**
  - `setInterval` configured for 5000ms (5 seconds)
  - Sends `{ ping: {} }` to maintain connection
  - Debug logging confirms ping sending

- [x] **Ping loop and inactivity watchdog are both cleaned up on shutdown**
  - `clearPingInterval()` called in all exit paths
  - `clearInactivityTimeout()` already existed and works
  - Both work independently without conflict
  - No resource leaks

- [x] **No new TODOs, mocks, or skeleton code added**
  - Only production-ready code
  - Tests use existing mock patterns
  - No placeholders

- [x] **All existing tests still pass**
  - 70 tests pass (2 skipped as before)
  - 4 new tests added for auto-injection
  - No failures or regressions

## Production Safety Improvements

### 1. Discriminator Filter Protection
**Before**: Could subscribe to all Kamino program accounts (dangerous)
**After**: Always subscribes with obligation discriminator filter (safe)

**Impact**:
- Prevents accidental subscription to thousands of unrelated accounts
- Reduces bandwidth and processing overhead
- Ensures only obligation accounts are processed
- Critical for liquidation bot correctness

### 2. Active Connection Maintenance
**Before**: Only listened for pings (passive)
**After**: Actively sends pings every 5 seconds (active)

**Impact**:
- Prevents silent disconnects in production
- Maintains connection health in hostile network conditions
- Detects connection issues faster
- Critical for long-running processes with real capital

### 3. Resource Management
**Before**: Only inactivity timer cleanup
**After**: Both inactivity timer and ping interval cleanup

**Impact**:
- No timer leaks
- Clean shutdown behavior
- Proper resource management
- Suitable for production deployment

## Code Quality

- ✅ TypeScript typecheck passes
- ✅ All tests pass (70/72)
- ✅ Minimal changes (surgical edits only)
- ✅ No unrelated refactoring
- ✅ Consistent with existing patterns
- ✅ Well-documented with comments

## Constraints Met

- ✅ No changes to `src/commands/liveIndexer.ts`
- ✅ No changes to `src/commands/snapshotObligations.ts`
- ✅ No changes to `data/obligations.jsonl`
- ✅ No changes to Kamino decode logic
- ✅ No changes to RPC bootstrap logic
- ✅ No changes to filter normalization logic
- ✅ No changes to snapshot behavior
- ✅ No changes to public function signatures (except what was already merged)

## Files Modified

1. `src/engine/liveObligationIndexer.ts` - Auto-inject discriminator filter
2. `src/yellowstone/subscribeAccounts.ts` - Outbound ping loop
3. `src/__tests__/auto-inject-discriminator.test.ts` - New tests (added)

## Production Considerations

This is a **production liquidation bot** with:
- Long-running processes
- Real capital at risk
- Hostile network conditions
- Critical correctness requirements

The changes address:
1. **Safety**: Cannot accidentally subscribe to wrong accounts
2. **Reliability**: Active connection maintenance prevents silent failures
3. **Resource management**: Proper cleanup prevents leaks
4. **Testing**: Comprehensive tests ensure correctness

## Migration Notes

No migration needed - changes are backwards compatible:
- Existing code with filters continues to work unchanged
- New code without filters gets safe defaults automatically
- No breaking changes to API or behavior

## Example Usage

```typescript
// Safe by default - discriminator auto-injected
const indexer = new LiveObligationIndexer({
  yellowstoneUrl: env.YELLOWSTONE_GRPC_URL,
  yellowstoneToken: env.YELLOWSTONE_X_TOKEN,
  programId: new PublicKey(env.KAMINO_KLEND_PROGRAM_ID),
  rpcUrl: env.RPC_PRIMARY,
  // filters: [] or undefined - will auto-inject discriminator
});

await indexer.start();
// Logs: "Auto-injected Obligation discriminator filter for safe subscription"
// Stream sends outbound pings every 5 seconds
// Inactivity watchdog monitors for incoming data
```

## Verification

To verify the fixes are working:

1. **Check logs for auto-injection**:
   ```
   INFO: Auto-injected Obligation discriminator filter for safe subscription
   discriminator: "a8ce8d6a584caca7"
   ```

2. **Check logs for outbound pings** (debug level):
   ```
   DEBUG: Sent outbound ping to Yellowstone gRPC
   ```

3. **Run tests**:
   ```bash
   npm test
   # Should show: Test Files  10 passed (10)
   #              Tests  70 passed | 2 skipped (72)
   ```

4. **Verify filter count in logs**:
   ```
   INFO: Starting Yellowstone subscription
   filtersCount: 1  # Should be 1, not 0
   ```

## Conclusion

Both required fixes are implemented with minimal, surgical changes:
- Obligation discriminator filter is now enforced by default
- Outbound pings maintain connection health in production
- All tests pass with comprehensive coverage
- Production-ready for long-running liquidation bot deployment
