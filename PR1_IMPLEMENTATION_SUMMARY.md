# PR1: Real Yellowstone Wiring Implementation Summary

## Overview
Successfully implemented real Yellowstone gRPC-based event-driven refresh for the liquidation bot, replacing the previous simulated event system with production-ready subscriptions using explicit pubkey subscriptions.

## Key Changes

### 1. Mint→Obligation Mapping (`src/monitoring/mintObligationMapping.ts`)
- **New module** that builds efficient mapping from mints to obligation keys
- Loads from `data/tx_queue.json` or falls back to `data/candidates.json`
- Defaults to USDC + SOL if no assets field present
- Supports dynamic updates via `updateMappingOnPlanChange()`
- Used by orchestrator to refresh only impacted obligations on price events

### 2. Real Yellowstone Account Listener (`src/monitoring/yellowstoneAccountListener.ts`)
- **Replaced stub** with real gRPC subscription implementation
- Subscribes to explicit account pubkeys (obligations)
- Implements:
  - Dedupe by `(pubkey, slot)` to prevent duplicate processing
  - Burst coalescing with configurable debounce window (100-250ms default: 150ms)
  - Exponential backoff reconnection (1s → 30s max)
  - Liveness tracking (message count, reconnect count, last message timestamp)
- Uses numeric `CommitmentLevel.CONFIRMED = 1` to avoid import issues
- Maintains `simulateAccountUpdate()` helper for testing

### 3. Real Yellowstone Price Listener (`src/monitoring/yellowstonePriceListener.ts`)
- **Replaced stub** with real gRPC subscription for oracle accounts
- Subscribes to explicit oracle pubkeys
- Similar reliability features as account listener:
  - Dedupe, coalescing, backoff, liveness tracking
- Emits `price-update` events with oracle pubkey and slot
- Mint resolution done externally via oracle→mint mapping
- Maintains `simulatePriceUpdate()` helper for testing

### 4. Event Refresh Orchestrator Updates (`src/monitoring/eventRefreshOrchestrator.ts`)
- **Integrated mint→obligation mapping** from new module
- **Single-pass throttle check** - `canRefresh(key)` evaluated once per obligation per event
- **Bounded batch size** for price updates (default: 50, configurable via `EVENT_REFRESH_BATCH_LIMIT`)
- Account updates:
  - Single-pass throttle on obligation key
  - Optional significance check (health delta >= threshold)
- Price updates:
  - Resolves obligations by mint via mapping
  - Applies per-obligation throttle in single pass
  - Respects batch limit to avoid overwhelming refresh
- Structured logging with pino for all refresh operations

### 5. Bot Startup Scheduler Wiring (`src/scheduler/botStartupScheduler.ts`)
- **Derives obligation pubkeys** from `loadQueue()` - reads from `data/tx_queue.json`
- **Derives oracle pubkeys** from reserves via `loadReserves()` + market connection
- **Builds oracle→mint mapping** using `getMintsByOracle()` from reserve cache
- Initializes listeners with:
  - `YELLOWSTONE_GRPC_URL` (primary env var, accepts aliases)
  - `YELLOWSTONE_X_TOKEN` (primary env var, accepts aliases)
  - Explicit pubkey lists (no broad program filters in PR1)
- Wires orchestrator to handle events from both listeners
- Maps oracle updates to mints for price-driven refresh

### 6. Smoke Test (`scripts/test_yellowstone_smoke.ts`)
- **Deterministic SLOT stream test** - subscribes to slot updates only
- Succeeds if any slot update received within 10 seconds
- Uses numeric `CommitmentLevel.CONFIRMED = 1`
- Validates Yellowstone endpoint connectivity without needing account data
- WSL wrapper: `scripts/run_test_yellowstone_smoke_wsl.ps1`

### 7. Package.json Scripts
- Added `test:yellowstone:smoke` - native smoke test
- Added `test:yellowstone:smoke:wsl` - Windows/WSL wrapper
- **All existing scripts preserved** and still functional

### 8. Test Data
- Created minimal `data/tx_queue.json` for testing with:
  - Single obligation key
  - EV, TTL, hazard fields
  - Assets array (SOL, USDC)

## Environment Variables (Unchanged Names)
- `YELLOWSTONE_GRPC_URL` - primary env var (kept as specified)
- `YELLOWSTONE_X_TOKEN` - primary env var (kept as specified)  
- `EVENT_MIN_REFRESH_INTERVAL_MS` - per-obligation throttle (default: 3000ms)
- `EVENT_REFRESH_BATCH_LIMIT` - max obligations per price event (default: 50)
- `MIN_HEALTH_DELTA` - significance threshold for account updates (default: 0.01)

## Hard Rules Compliance ✓
- ✅ Kept existing env var names (`YELLOWSTONE_GRPC_URL`, `YELLOWSTONE_X_TOKEN`)
- ✅ Kept ALL existing npm scripts working
- ✅ New test command exists in native + WSL wrapper versions
- ✅ Subscribe by explicit pubkeys only (no broad program filters)
- ✅ `canRefresh(key)` evaluated once per obligation per event
- ✅ Did not touch liquidation execution, Jupiter swap, or broadcast logic

## Testing
- ✅ TypeScript build passes (`npm run build`)
- ✅ TypeCheck passes (`npm run typecheck`)
- ✅ Existing test passes: `npm run test:forecast-realtime-refresh`
- ⏸️ Smoke test requires valid `YELLOWSTONE_GRPC_URL` + auth token (not run in this session)

## Known Limitations / Future Work
- PR1 does not decode oracle price data - price impact is detected via account update alone
- Oracle→mint mapping is static at startup - dynamic reserve changes need restart
- Smoke test requires live Yellowstone endpoint to validate connectivity

## Files Created
- `src/monitoring/mintObligationMapping.ts`
- `scripts/test_yellowstone_smoke.ts`
- `scripts/run_test_yellowstone_smoke_wsl.ps1`
- `data/tx_queue.json` (test fixture)

## Files Modified
- `src/monitoring/yellowstoneAccountListener.ts` - Real gRPC implementation
- `src/monitoring/yellowstonePriceListener.ts` - Real gRPC implementation
- `src/monitoring/eventRefreshOrchestrator.ts` - Mint mapping + single-pass throttle
- `src/scheduler/botStartupScheduler.ts` - Real listener initialization
- `scripts/test_forecast_realtime_refresh.ts` - Updated to match new API
- `package.json` - Added smoke test scripts

## Implementation Notes
- Used numeric `CommitmentLevel` values (CONFIRMED=1) to avoid import issues with tsx
- Listeners maintain `simulate*` methods for testing without live connections
- Oracle→mint resolution done in scheduler before calling orchestrator
- Dedupe sets cleared on reconnect to prevent unbounded memory growth
- Exponential backoff capped at 30s to prevent excessive delays

## Security Considerations
- Auth token never logged (handled by logger)
- gRPC connections use provided credentials
- No change to liquidation or broadcast security posture

## Performance Impact
- Event-driven refresh reduces unnecessary RPC calls
- Mint mapping eliminates full queue scans on price events
- Bounded batch size prevents refresh queue overflow
- Debounce/coalescing reduces duplicate work during burst events

## Deployment Notes
- Requires valid Yellowstone gRPC endpoint + auth token in production
- Bot will reconnect automatically on connection loss (exponential backoff)
- Liveness events emitted for monitoring integration (future work)
- Existing periodic refresh can be disabled via `SCHEDULER_ENABLE_REFRESH=false`
