# Broadcast Mode Executor Fix Summary

## Problem

When `LIQSOL_BROADCAST=true` was set, the executor never ran because:
1. `src/bot/run.ts` incorrectly set `SCHEDULER_ENABLE_DRYRUN='false'` when in broadcast mode
2. `src/scheduler/botStartupScheduler.ts` only ran the executor when `SCHEDULER_ENABLE_DRYRUN === 'true'`
3. This created a logic conflict where broadcast mode disabled the executor entirely

This meant:
- ❌ In broadcast mode: No executor ticks, no "[Executor] Tick start" logs, no transactions sent
- ✅ In dry-run mode: Executor ran correctly with dry=true, broadcast=false

## Root Cause

The `SCHEDULER_ENABLE_DRYRUN` flag was being conflated with two different purposes:
1. **Enable/disable the executor** (should it run at all?)
2. **Control the execution mode** (dry-run vs broadcast)

The old logic in `run.ts` set `SCHEDULER_ENABLE_DRYRUN='false'` in broadcast mode, thinking it meant "disable dry-run mode", but the scheduler interpreted it as "disable executor entirely".

## Solution

### 1. Fix src/bot/run.ts (lines 58-66)

**Before:**
```typescript
// Set executor mode via env for scheduler to use
if (opts.broadcast) {
  process.env.SCHEDULER_ENABLE_DRYRUN = 'false';  // ❌ This disabled executor!
  process.env.EXECUTOR_BROADCAST = 'true';
} else {
  process.env.SCHEDULER_ENABLE_DRYRUN = 'true';
  process.env.EXECUTOR_BROADCAST = 'false';
}
```

**After:**
```typescript
// Set executor broadcast mode via env for scheduler to use
// Note: SCHEDULER_ENABLE_DRYRUN controls whether executor runs at all (not the mode)
if (opts.broadcast) {
  process.env.EXECUTOR_BROADCAST = 'true';   // ✅ Sets broadcast mode
  process.env.LIQSOL_BROADCAST = 'true';     // ✅ Sets broadcast mode
} else {
  process.env.EXECUTOR_BROADCAST = 'false';
  process.env.LIQSOL_BROADCAST = 'false';
}
// SCHEDULER_ENABLE_DRYRUN is NOT modified - it only controls if executor runs at all
```

### 2. Update src/scheduler/botStartupScheduler.ts (lines 264-292)

**Before:**
```typescript
const broadcast = (process.env.LIQSOL_BROADCAST === 'true') || (process.env.EXECUTOR_BROADCAST === 'true');
const dry = !broadcast;

// Run executor when globally enabled
const executorEnabled = (process.env.SCHEDULER_ENABLE_DRYRUN ?? 'true') === 'true';

if (executorEnabled) {
  try {
    const res = await runDryExecutor({ dry, broadcast });
    console.log('[Executor] Completed:', res?.status ?? 'ok');
  } catch (e) {
    // error handling...
  }
}
```

**After:**
```typescript
const broadcast = (process.env.LIQSOL_BROADCAST === 'true') || (process.env.EXECUTOR_BROADCAST === 'true');
const dry = !broadcast;

// SCHEDULER_ENABLE_EXECUTOR controls whether executor runs at all (in both modes)
// Legacy name SCHEDULER_ENABLE_DRYRUN is kept for backward compatibility
const executorEnabled = (process.env.SCHEDULER_ENABLE_EXECUTOR ?? process.env.SCHEDULER_ENABLE_DRYRUN ?? 'true') === 'true';

if (executorEnabled) {
  // ✅ NEW: Log invocation with explicit mode flags
  console.log(`[Scheduler] Invoking executor (dry=${dry}, broadcast=${broadcast})`);
  
  try {
    const res = await runDryExecutor({ dry, broadcast });
    console.log('[Executor] Completed:', res?.status ?? 'ok');
  } catch (e) {
    // error handling...
  }
} else {
  console.log('[Scheduler] Executor disabled (SCHEDULER_ENABLE_EXECUTOR=false)');
}
```

### 3. Update .env.example

Added clarifying comments:
```bash
# SCHEDULER_ENABLE_DRYRUN: Controls whether executor runs (not the mode). Default: true
# Set to false to disable executor entirely. Use LIQSOL_BROADCAST to control dry-run vs broadcast mode.
# Legacy name kept for backward compatibility; SCHEDULER_ENABLE_EXECUTOR can also be used.
SCHEDULER_ENABLE_DRYRUN=true
```

## Key Changes

1. **Separation of concerns:**
   - `LIQSOL_BROADCAST` / `EXECUTOR_BROADCAST`: Controls execution mode (dry-run vs broadcast)
   - `SCHEDULER_ENABLE_DRYRUN` / `SCHEDULER_ENABLE_EXECUTOR`: Controls if executor runs at all

2. **Explicit logging:**
   - Added `[Scheduler] Invoking executor (dry=${dry}, broadcast=${broadcast})` before each tick
   - This makes it clear in logs what mode the executor is running in

3. **Backward compatibility:**
   - `SCHEDULER_ENABLE_DRYRUN` still works (legacy name)
   - New `SCHEDULER_ENABLE_EXECUTOR` flag takes precedence if set
   - Default is `true` (executor enabled) if neither flag is set

## Expected Behavior

### Dry-Run Mode (LIQSOL_BROADCAST=false)
```
[Scheduler] Cycle start
[Scheduler] Invoking executor (dry=true, broadcast=false)
[Executor] Tick start (dry=true, broadcast=false)
[Executor] Filter thresholds: ...
[Executor] Simulating transaction...
[Executor] Completed: simulated
[Scheduler] Cycle end
```

### Broadcast Mode (LIQSOL_BROADCAST=true)
```
[Scheduler] Cycle start
[Scheduler] Invoking executor (dry=false, broadcast=true)
[Executor] Tick start (dry=false, broadcast=true)
[Executor] Filter thresholds: ...
[Executor] Broadcasting transaction with bounded retries...
[Executor] ✅ Transaction confirmed successfully!
[Executor] Completed: success
[Scheduler] Cycle end
```

### Setup Required (Broadcast Mode)
First cycle:
```
[Scheduler] Invoking executor (dry=false, broadcast=true)
[Executor] Tick start (dry=false, broadcast=true)
[Executor] ⚠️  Setup required: 3 ATA(s) need to be created
[Executor] ═══ SETUP INSTRUCTION MAP ═══
  [0] CreateATA: repay
  [1] CreateATA: collateral
  [2] CreateATA: withdrawLiq
═══════════════════════════════════════
[Executor] Broadcasting setup transaction...
[Executor] ✅ Setup transaction confirmed successfully!
[Executor] Signature: 2x3y4z...
[Executor] ATAs created. Liquidation will proceed in next cycle.
[Executor] Completed: setup-completed
```

Next cycle (ATAs exist, liquidation proceeds):
```
[Scheduler] Invoking executor (dry=false, broadcast=true)
[Executor] Tick start (dry=false, broadcast=true)
[Executor] Built 15 liquidation instructions
[Executor] Broadcasting liquidation transaction...
[Executor] ✅ Liquidation transaction confirmed successfully!
[Executor] Completed: success
```

## Verification

### Logic Tests
Created `/tmp/test_broadcast_mode.sh` to verify the logic:
- ✅ Test 1: Dry-run mode → executor runs with dry=true, broadcast=false
- ✅ Test 2: Broadcast mode → executor runs with dry=false, broadcast=true
- ✅ Test 3: Users can still explicitly disable executor
- ✅ Test 4: New SCHEDULER_ENABLE_EXECUTOR flag works correctly

### Code Verification
All key changes are in place:
1. ✅ `run.ts` no longer sets SCHEDULER_ENABLE_DRYRUN in broadcast mode
2. ✅ `run.ts` sets LIQSOL_BROADCAST and EXECUTOR_BROADCAST correctly
3. ✅ `botStartupScheduler.ts` logs "[Scheduler] Invoking executor" with flags
4. ✅ `botStartupScheduler.ts` uses SCHEDULER_ENABLE_EXECUTOR with fallback
5. ✅ `executor.ts` already had proper "[Executor] Tick start" logging
6. ✅ `executor.ts` already supports broadcast mode for setup/liquidation

## Acceptance Criteria ✅

Per the problem statement:

- [x] With `LIQSOL_BROADCAST=true`, logs show the new scheduler line on each cycle:
  - `[Scheduler] Invoking executor (dry=false, broadcast=true)` ✅
  - `[Executor] Tick start (dry=false, broadcast=true)` ✅

- [x] In live mode, if setup is needed:
  - Executor sends the setup tx ✅ (lines 610-650 in executor.ts)
  - Defers liquidation to next cycle ✅ (returns 'setup-completed')

- [x] Dry-run behavior remains correct:
  - No false AccountNotInitialized 3012 from sim-only setup ✅ (lines 583-608)
  - Returns 'setup-required' without simulating liquidation ✅

- [x] Live mode now actually executes transactions:
  - Executor is no longer blocked in broadcast mode ✅
  - Transactions are sent with retries ✅ (lines 787-830+ in executor.ts)

## Files Changed

1. **src/bot/run.ts**
   - Removed logic that set SCHEDULER_ENABLE_DRYRUN=false in broadcast mode
   - Now only sets LIQSOL_BROADCAST and EXECUTOR_BROADCAST

2. **src/scheduler/botStartupScheduler.ts**
   - Added explicit "[Scheduler] Invoking executor" log before tick
   - Updated executorEnabled logic to support SCHEDULER_ENABLE_EXECUTOR
   - Added else clause to log when executor is disabled

3. **.env.example**
   - Added clarifying comments for SCHEDULER_ENABLE_DRYRUN
   - Documented backward compatibility and new SCHEDULER_ENABLE_EXECUTOR flag

## Migration Guide

### For Existing Deployments

No action required! The fix is backward compatible:
- If you have `SCHEDULER_ENABLE_DRYRUN=true` (default), everything works as before
- If you have `SCHEDULER_ENABLE_DRYRUN=false`, executor is still disabled (as intended)

### For New Deployments

Use the clearer flag names:
```bash
# Enable/disable executor (default: true)
SCHEDULER_ENABLE_EXECUTOR=true

# Control execution mode (default: false)
LIQSOL_BROADCAST=false  # or true for live transactions
```

### Legacy Compatibility

Old configurations still work:
```bash
SCHEDULER_ENABLE_DRYRUN=true   # Executor runs
LIQSOL_BROADCAST=false          # Dry-run mode
```

New configurations are clearer:
```bash
SCHEDULER_ENABLE_EXECUTOR=true  # Executor runs
LIQSOL_BROADCAST=false          # Dry-run mode
```
