# PR 8.7 Hotfix: Normalize Candidates Payload

## Problem
The dry-run command crashed with `TypeError: candidates.map is not a function` when `data/candidates.json` had a nested structure like `{ "candidates": [...] }` instead of a plain array `[...]`.

## Root Cause
The original implementation assumed that loading the JSON file would always return an array directly:
```typescript
let candidates = loadCandidatesScored() ?? loadCandidatesRaw();
// candidates was expected to be an array, but could be an object
ranked = candidates.map((c: any) => { ... }); // ❌ TypeError if candidates is an object
```

When the JSON file had a structure like:
```json
{
  "candidates": [
    { "key": "test1", ... },
    { "key": "test2", ... }
  ]
}
```

The `candidates` variable would be an object, not an array, causing `.map()` to fail.

## Solution
Added a `normalizeCandidates()` helper function that handles multiple payload structures and always returns an array:

### Supported Payload Structures
1. **Array**: `[...]` → returns as-is
2. **Object with "candidates"**: `{ "candidates": [...] }` → returns `payload.candidates`
3. **Object with "data"**: `{ "data": [...] }` → returns `payload.data`
4. **Keyed dictionary**: `{ "pubkey1": {...}, "pubkey2": {...} }` → returns `Object.values(payload)`
5. **Empty/null/undefined**: → returns `[]`

### Implementation
```typescript
function normalizeCandidates(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.candidates)) return payload.candidates;
  return Object.values(payload);
}
```

### Updated Loading Functions
Changed return type from `any[]` to `any` to accept any structure:
```typescript
function loadCandidatesScored(): any | null { ... }
function loadCandidatesRaw(): any { ... }
```

### Normalization Step
Added normalization immediately after loading:
```typescript
const scoredPayload = loadCandidatesScored();
const rawPayload = scoredPayload ?? loadCandidatesRaw();
let candidates = normalizeCandidates(rawPayload);

logger.info({
  event: "forecast_candidates_loaded",
  source: scoredPayload ? "scored" : "raw",
  isArray: Array.isArray(rawPayload),
  normalizedCount: candidates.length,
}, "Loaded forecast candidates");
```

### Added Safety Guard
Added check for empty candidate array:
```typescript
if (!Array.isArray(candidates) || candidates.length === 0) {
  throw new Error("No candidates available (empty or invalid candidates payload)");
}
```

### Enhanced Ranking
Added explicit `key` field to each candidate for consistent display:
```typescript
ranked = candidates.map((c: any) => {
  // ... compute hazard, ev, ttlMin, ttlStr
  return { ...c, key: c.key ?? c.obligationPubkey ?? 'unknown', hazard, ev, ttlMin, ttlStr };
})
```

## Changes Made

### Files Modified
1. **src/commands/flashloanDryRunKamino.ts**
   - Added `normalizeCandidates()` function
   - Updated `loadCandidatesScored()` return type to `any | null`
   - Updated `loadCandidatesRaw()` return type to `any`
   - Added normalization step after loading
   - Added logging for source, payload type, and normalized count
   - Added empty array guard
   - Enhanced ranking to add `key` field and `borrowValueUsd` to table output

2. **scripts/verify_forecast_ranking.ts**
   - Added `normalizeCandidates()` function
   - Updated `loadCandidatesRaw()` to normalize payload

### Files Added
1. **scripts/test_normalize_candidates.ts** - Unit tests for normalization function
2. **scripts/test_hotfix_nested_payload.ts** - Integration test for the specific bug scenario
3. **scripts/test_all_payload_formats.ts** - Comprehensive test for all supported formats
4. **data/candidates.array.json** - Test file with array format
5. **data/candidates.data.json** - Test file with data format

## Test Results

### Unit Tests ✅
All normalization test cases pass:
```
✅ Array payload → Array (2 items)
✅ Object with "candidates" → Array (2 items)
✅ Object with "data" → Array (2 items)
✅ Keyed object → Array (2 items)
✅ Empty object → Array (0 items)
✅ Null/undefined → Array (0 items)
✅ Actual candidates.json → Array (3 items)
```

### Integration Test ✅
Nested payload hotfix test passes:
```
✅ Raw payload correctly detected as Object
✅ Normalized to Array with 3 items
✅ .map() works without errors
✅ Ranking logic completes successfully
✅ Top candidate selected: test-obligation-2 (EV=$146.17)
```

### Comprehensive Format Test ✅
All payload formats work:
```
✅ candidates.json (nested: { "candidates": [...] }) → 3 items
✅ candidates.array.json (array: [...]) → 2 items
✅ candidates.data.json (nested: { "data": [...] }) → 2 items
```

### Forecast Ranking Verification ✅
Ranking algorithm still works correctly:
```
Rank 1: test-obligation-2 (EV=$146.17, TTL=10m00s, Hazard=0.67)
Rank 2: test-obligation-1 (EV=$45.06, TTL=25m00s, Hazard=0.44)
Rank 3: test-obligation-3 (EV=$9.79, TTL=50m00s, Hazard=0.29)
```

## Validation

### Before Hotfix
```bash
# Would crash with:
TypeError: candidates.map is not a function
    at main (flashloanDryRunKamino.ts:153)
```

### After Hotfix
```bash
# Works correctly:
{"level":30,"time":...,"event":"forecast_candidates_loaded","source":"raw","isArray":false,"normalizedCount":3}
{"level":30,"time":...,"event":"forecast_ranking_enabled"}

📊 Top 10 Ranked Candidates by EV/TTL/Hazard:
┌─────────┬─────────────────────┬─────────────┬──────────┬────────────┬──────────┬────────────────┐
│ (index) │ key                 │ healthRatio │ hazard   │ ev         │ ttl      │ borrowValueUsd │
├─────────┼─────────────────────┼─────────────┼──────────┼────────────┼──────────┼────────────────┤
│ 0       │ 'test-obligation-2' │ '1.0200'    │ '0.6667' │ '146.1667' │ '10m00s' │ '10000.00'     │
│ 1       │ 'test-obligation-1' │ '1.0500'    │ '0.4444' │ '45.0556'  │ '25m00s' │ '5000.00'      │
│ 2       │ 'test-obligation-3' │ '1.1000'    │ '0.2857' │ '9.7857'   │ '50m00s' │ '2000.00'      │
└─────────┴─────────────────────┴─────────────┴──────────┴────────────┴──────────┴────────────────┘
```

## Acceptance Criteria Met ✅

- ✅ Dry-run no longer crashes with `TypeError: candidates.map is not a function`
- ✅ Works with `{ "candidates": [...] }` structure
- ✅ Works with array `[...]` structure
- ✅ Works with `{ "data": [...] }` structure
- ✅ Works with keyed object structure
- ✅ Logging shows source (scored vs raw)
- ✅ Logging shows whether payload was array
- ✅ Logging shows normalized candidate count
- ✅ Top 10 ranking is displayed correctly
- ✅ Top candidate is selected for simulation
- ✅ Baseline behavior unchanged when forecast ranking disabled
- ✅ Added `borrowValueUsd` to table output for better visibility

## Impact
- **Breaking changes**: None
- **Backward compatibility**: 100% - all existing payload formats still work
- **New functionality**: Supports additional payload formats
- **Performance**: No impact - normalization is O(n) at most
- **Security**: No security implications

## Summary
This hotfix makes the forecast ranking robust to different JSON payload structures by normalizing any structure to an array before processing. It maintains full backward compatibility while fixing the critical bug that caused crashes with nested payloads.
