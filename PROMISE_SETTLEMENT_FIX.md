# Promise Settlement Fix Summary

## Problem Statement
The Yellowstone subscription handle had issues with promise settlement:
- `handle.close()` could be called but the promise might not settle correctly
- Using `isClosed` flag with early returns prevented proper promise resolution
- The `done` promise could potentially settle multiple times or not settle at all

## Solution Implemented

### Core Changes
Replaced the single `isClosed` flag with two separate flags:

1. **`closeRequested`**: Tracks whether `close()` has been called
   - Used for idempotent close operation
   - Prevents ping loop and inactivity timeout from running after close
   
2. **`settled`**: Ensures promise settles exactly once
   - Guards all `resolve()` and `reject()` calls
   - Prevents race conditions between event handlers

### Helper Functions

Created two helper functions that encapsulate settlement logic:

```typescript
const settleResolve = () => {
  if (settled) return;  // Guard: settle only once
  settled = true;
  clearInactivityTimeout();
  clearPingInterval();
  resolve();
};

const settleReject = (err: Error) => {
  if (settled) return;  // Guard: settle only once
  settled = true;
  clearInactivityTimeout();
  clearPingInterval();
  reject(err);
};
```

### Event Handler Changes

1. **error handler**: Calls `settleReject(err)` directly
2. **end handler**: Calls `settleResolve()` without early return
3. **close handler**: Calls `settleResolve()` without early return

Key improvement: Removed early returns that were checking `isClosed`, allowing handlers to always attempt settlement. The `settled` flag ensures idempotent behavior.

### close() Method

```typescript
close: () => {
  if (closeRequested) return;  // Idempotent
  closeRequested = true;
  clearInactivityTimeout();
  clearPingInterval();
  stream.destroy();  // Triggers close event -> settleResolve()
  logger.debug("Subscription stream closed via handle.close()");
}
```

## Benefits

1. **Deterministic Promise Settlement**: The `done` promise always resolves or rejects exactly once
2. **Idempotent close()**: Can be called multiple times safely
3. **No Race Conditions**: The `settled` flag prevents multiple handlers from settling the promise
4. **Clean Separation**: `closeRequested` tracks close intent, `settled` tracks promise state
5. **Proper Cleanup**: Timers are always cleaned up when promise settles

## Testing

All 70 existing tests pass (2 skipped), confirming:
- No regressions in existing functionality
- The subscription handle works correctly with the new logic
- Reconnection and shutdown behavior is maintained

## Technical Details

### Flow on handle.close()
1. User calls `handle.close()`
2. `closeRequested` is set to `true`
3. Timers are cleared
4. `stream.destroy()` is called
5. Stream emits "close" event
6. "close" handler calls `settleResolve()`
7. `settled` flag is set and promise resolves (only once)

### Flow on stream error
1. Stream emits "error" event with Error object
2. "error" handler calls `settleReject(err)`
3. `settled` flag is set and promise rejects (only once)
4. Other handlers may fire but `settled` guard prevents re-settlement

### Flow on stream end
1. Stream emits "end" event
2. "end" handler calls `settleResolve()`
3. `settled` flag is set and promise resolves (only once)
4. "close" event may fire afterward but `settled` guard prevents re-settlement

## Files Modified

- `src/yellowstone/subscribeAccounts.ts` (121-260) - Complete rewrite of promise settlement logic

## Unchanged (as required)

- Ping interval logic (still sends pings every 5 seconds)
- Inactivity watchdog logic (still monitors for inactivity)
- Filter normalization (unchanged)
- Request shape (unchanged)

## Optional Future Improvement (Not Implemented)

The problem statement mentioned that `bootstrapCacheFromRpc()` hardcodes `"confirmed"` commitment level instead of using `this.config.commitment`. This is a consistency issue but was marked as non-blocking and not implemented in this PR edit.

Locations with hardcoded "confirmed":
- Line 139: `new Connection(this.config.rpcUrl, "confirmed")`
- Line 165: `connection.getMultipleAccountsInfo(batch, "confirmed")`

This can be addressed in a future PR if desired.
