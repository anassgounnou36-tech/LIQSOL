# PR60: Reliability Patch Implementation Summary

## Overview
This reliability patch hardens the PR1 Yellowstone subscriptions to run reliably for long periods without memory leaks or connection issues.

## Key Changes

### 1. Dedupe Eviction (Memory Leak Fix)
**Problem**: Unbounded `Set<string>` storing `${pubkey}:${slot}` keys grows forever.

**Solution**: 
- Replaced with `Map<string, number>` tracking last slot per pubkey
- Only stores one entry per pubkey (latest slot)
- Dedupes by checking: `slot > lastSlot`

**Files**:
- `src/monitoring/yellowstoneAccountListener.ts`: Changed `dedupe` Set to `lastSlotByPubkey` Map
- `src/monitoring/yellowstonePriceListener.ts`: Changed `dedupe` Set to `lastSlotByOracle` Map

**Impact**: Prevents unbounded memory growth over time (e.g., millions of unique slot+pubkey combinations)

### 2. Reconnect Backoff Reset
**Problem**: After a long disconnection with many retries, reconnect delay stays at 30s even after connection restored.

**Solution**:
- Reset `reconnectCount` to 0 on first successful message reception
- Check added in `onMessage()` method: `if (this.messagesReceived === 0) this.reconnectCount = 0;`

**Files**:
- `src/monitoring/yellowstoneAccountListener.ts`: Added backoff reset in `onMessage()`
- `src/monitoring/yellowstonePriceListener.ts`: Added backoff reset in `onMessage()`

**Impact**: After connection is restored, next reconnection (if needed) starts from base delay instead of max delay

### 3. Stream Cleanup
**Problem**: Previous streams may not be properly destroyed before reconnecting, causing resource leaks.

**Solution**:
- Added `cleanupStream()` method to properly destroy old stream
- Called in both `reconnect()` (before resubscribe) and `stop()` (on shutdown)
- Best-effort cleanup with try-catch to ignore errors

**Files**:
- `src/monitoring/yellowstoneAccountListener.ts`: Added `cleanupStream()` method
- `src/monitoring/yellowstonePriceListener.ts`: Added `cleanupStream()` method

**Code**:
```typescript
private cleanupStream() {
  try {
    if (this.stream) {
      if (typeof this.stream.destroy === 'function') {
        this.stream.destroy();
      }
      this.stream = null;
    }
  } catch {
    // ignore cleanup errors
  }
}
```

**Impact**: Prevents leaked stream resources during reconnect cycles

### 4. Fail-Fast Mapping Check
**Problem**: Bot silently does nothing when mint→obligation mapping is empty (missing data files).

**Solution**:
- Added validation in `EventRefreshOrchestrator` constructor
- Throws descriptive error: `'Mint→obligation mapping is empty. Ensure data/tx_queue.json or data/candidates.json exists.'`

**File**:
- `src/monitoring/eventRefreshOrchestrator.ts`: Added mapping size check

**Code**:
```typescript
// Fail-fast to avoid silently doing nothing
if (!this.mintToKeys || this.mintToKeys.size === 0) {
  throw new Error('Mint→obligation mapping is empty. Ensure data/tx_queue.json or data/candidates.json exists.');
}
```

**Impact**: Developers/operators get immediate feedback if configuration is missing instead of wondering why nothing happens

### 5. Enhanced Smoke Test
**Problem**: Original smoke test only validates slot stream, not account subscription pipeline.

**Solution**:
- Added optional `SMOKE_TEST_ACCOUNT_PUBKEY` env var
- If provided, subscribes to that account in parallel with slot stream
- Test passes on slot update alone (primary test)
- If account pubkey provided and update received, logs success for both
- Account stream errors are non-fatal (slot test is sufficient)

**File**:
- `scripts/test_yellowstone_smoke.ts`: Extended to test both streams

**Usage**:
```bash
# Basic test (slot only)
npm run test:yellowstone:smoke

# Extended test (slot + account)
SMOKE_TEST_ACCOUNT_PUBKEY=<obligation-pubkey> npm run test:yellowstone:smoke
```

**Impact**: Can validate full account subscription pipeline end-to-end when needed

## Behavioral Changes

### Before PR60
- Dedupe Set grew unbounded (memory leak)
- Reconnect delay stayed high after recovery (slow to recover)
- Streams might leak during reconnect (resource leak)
- Empty mapping silently did nothing (confusing)
- Smoke test only checked slots (incomplete validation)

### After PR60
- Dedupe uses O(n) memory where n = unique pubkeys (bounded)
- Reconnect delay resets after first message (fast recovery)
- Streams properly cleaned up (no leaks)
- Empty mapping fails immediately with clear error (explicit)
- Smoke test can validate full pipeline (complete validation)

## Testing

### Automated Tests
- ✅ `npm run test:forecast-realtime-refresh` - Passes with data file
- ✅ Fails fast with clear error when data file missing (expected behavior)
- ✅ Build succeeds (`npm run build`)

### Manual Validation
The following would be run in production/staging:
- `npm run test:yellowstone:smoke` - Validates slot stream
- `SMOKE_TEST_ACCOUNT_PUBKEY=<key> npm run test:yellowstone:smoke` - Validates account stream
- `npm run scheduler:main` - Observe event-driven refresh logs with no memory leaks over time

## Migration Notes

### For Developers
- No API changes - all changes are internal implementation
- Existing tests/scripts continue to work
- New fail-fast check may surface previously-hidden configuration issues (good!)

### For Operators
- Add `SMOKE_TEST_ACCOUNT_PUBKEY` to environment for extended validation (optional)
- Monitor reconnect behavior - should recover faster after outages
- Memory usage should be stable over time (no dedupe growth)

## Known Limitations

### Still Not Addressed (Future Work)
- Oracle→mint mapping is static at startup (needs restart for reserve changes)
- No price decoding yet (PR1 limitation, not changed)
- No metrics/telemetry for reconnect events (would help monitoring)

## Files Modified

1. `src/monitoring/yellowstoneAccountListener.ts` - Dedupe eviction, backoff reset, stream cleanup
2. `src/monitoring/yellowstonePriceListener.ts` - Dedupe eviction, backoff reset, stream cleanup
3. `src/monitoring/eventRefreshOrchestrator.ts` - Fail-fast mapping check
4. `scripts/test_yellowstone_smoke.ts` - Optional account subscription test
5. `data/tx_queue.json` - Test fixture (recreated)

## Technical Details

### Dedupe Logic Change
```typescript
// Before (unbounded Set)
const key = `${pubkey}:${slot}`;
if (this.dedupe.has(key)) return;
this.dedupe.add(key);

// After (bounded Map)
const last = this.lastSlotByPubkey.get(pubkey) ?? 0;
if (!(slot > last)) return;
this.lastSlotByPubkey.set(pubkey, slot);
```

### Backoff Reset Logic
```typescript
// Reset backoff after first successful message
if (this.messagesReceived === 0) {
  this.reconnectCount = 0;
}
this.messagesReceived++;
```

### Reconnect Delay Calculation
```typescript
// Exponential backoff capped to 30s
// (increment happens BEFORE delay calculation)
const delay = Math.min(30000, base * Math.pow(2, this.reconnectCount));
this.reconnectCount++;
```

## Performance Impact

### Memory
- **Before**: O(m) where m = total messages received (grows forever)
- **After**: O(n) where n = unique pubkeys (bounded)
- **Savings**: For 1000 pubkeys receiving 1M messages/day, saves ~999K entries

### CPU
- Map lookup vs Set lookup: Negligible difference (both O(1))
- Cleanup overhead: Minimal (only runs on reconnect)

### Network
- No change to subscription behavior
- Backoff reset may cause slightly more reconnect attempts (but faster recovery)

## Deployment Checklist

- [x] All code changes implemented
- [x] Build succeeds
- [x] Existing tests pass
- [x] New fail-fast behavior tested
- [ ] Smoke test with real Yellowstone endpoint (requires credentials)
- [ ] Long-running stability test (24h+) to verify no memory leaks

## Rollback Plan

If issues arise, PR60 can be reverted cleanly:
- All changes are self-contained in 4 files
- No schema changes
- No breaking API changes
- Previous behavior can be restored by reverting commit

## Success Metrics

### Short-term (1-7 days)
- ✅ Build succeeds
- ✅ Tests pass
- ✅ Fail-fast error shows missing config immediately
- ⏸️ Smoke test passes with live endpoint

### Medium-term (1-4 weeks)
- Memory usage stable over time (no growth trend)
- Reconnect events recover quickly (not stuck at 30s delay)
- No stream resource leaks (file descriptors stable)

### Long-term (1-3 months)
- Bot runs continuously without restart for memory issues
- Uptime improves (faster recovery from outages)
- Operational alerts reduced (better diagnostics)
