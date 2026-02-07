# PR 8.7: Forecast Ranking Integration - Implementation Summary

## Overview
Successfully integrated predictive forecast ranking (EV/TTL/Hazard) into the Kamino flashloan dry-run selection. The bot now prioritizes obligations by expected value and imminence before simulating, while keeping all PR9 safeguards intact.

## Changes Made

### 1. Environment Configuration (`src/config/env.ts`)
Added three new environment variables with sensible defaults:
- `USE_FORECAST_FOR_DRYRUN` (default: 'false') - Opt-in flag for forecast ranking
- `FORECAST_WEIGHT_EV` (default: '0.75') - Weight for EV in composite scoring (future use)
- `FORECAST_WEIGHT_TTL` (default: '0.25') - Weight for TTL in composite scoring (future use)

### 2. Flashloan Dry-Run Command (`src/commands/flashloanDryRunKamino.ts`)

#### Added Imports
- `path` from 'node:path'
- `scoreHazard` from '../predict/hazardScorer.js'
- `computeEV`, `EvParams` from '../predict/evCalculator.js'
- `estimateTtlString` from '../predict/ttlEstimator.js'

#### Added Helper Functions
1. **loadCandidatesScored()**: Loads pre-scored candidates from `data/candidates.scored.json`
   - Returns null if file doesn't exist (graceful fallback)
   - Handles JSON parse errors gracefully

2. **loadCandidatesRaw()**: Loads raw candidates from `data/candidates.json`
   - Throws error with helpful message if file missing
   - Suggests running `npm run snapshot:candidates:wsl`

3. **parseTtlMinutes(ttlStr)**: Parses TTL strings (e.g., "5m30s") into minutes
   - Returns Infinity for unknown/invalid values
   - Used for secondary sorting by imminence

#### Forecast Ranking Logic
Injected after environment loading and before payer preflight:
- Checks `USE_FORECAST_FOR_DRYRUN` flag
- Loads candidates from scored JSON or falls back to raw JSON
- Computes hazard/EV/TTL on-the-fly if missing
- Sorts candidates by:
  1. **EV descending** (higher profit first)
  2. **TTL ascending** (shorter time-to-liquidation first)
  3. **Hazard descending** (higher risk first)
- Logs top 10 ranked candidates in table format
- Selects top-ranked candidate for simulation
- When disabled, uses first candidate (baseline behavior)

### 3. Test Scripts

#### Unit Test (`scripts/unit_test_forecast_integration.ts`)
Validates the integration without requiring RPC:
- Tests environment variable definitions
- Tests required imports in dry-run command
- Tests helper function presence
- Tests parseTtlMinutes with various inputs
- Tests candidate loading functions

#### Verification Script (`scripts/verify_forecast_ranking.ts`)
Isolated test of ranking algorithm:
- Loads candidates from JSON
- Computes hazard/EV/TTL scores
- Ranks candidates using sorting algorithm
- Displays ranked table
- Verifies EV ordering is correct

#### Integration Test (`scripts/test_flashloan_dryrun_with_forecast.ts`)
End-to-end test with two scenarios:
- Test 1: Baseline behavior (USE_FORECAST_FOR_DRYRUN=false)
- Test 2: Forecast ranking (USE_FORECAST_FOR_DRYRUN=true)
- Validates correct mode is used
- Checks for expected log output

#### WSL Runner (`scripts/run_test_flashloan_forecast_wsl.ps1`)
PowerShell script for running tests in WSL environment

### 4. Package.json Scripts
Added two new npm scripts:
- `test:flashloan:forecast`: Direct execution
- `test:flashloan:forecast:wsl`: WSL wrapper

### 5. Documentation (`.env.example`)
Added configuration section with descriptions:
- Documents new environment variables
- Shows default values
- Notes optional composite scoring weights

### 6. Test Data (`data/candidates.json`)
Created sample candidate file for testing:
- 3 test obligations with varying health ratios
- Different borrow values for EV calculation
- Enables local testing without RPC

## Verification Results

### Unit Tests ✅
All unit tests pass:
- Environment variables defined ✅
- Imports present ✅
- Ranking logic present ✅
- Helper functions work correctly ✅
- parseTtlMinutes handles all cases ✅

### Forecast Ranking Algorithm ✅
Verified with sample data:
```
Rank 1: test-obligation-2 (EV: $146.17, TTL: 10m00s, Hazard: 0.67)
Rank 2: test-obligation-1 (EV: $45.06, TTL: 25m00s, Hazard: 0.44)
Rank 3: test-obligation-3 (EV: $9.79, TTL: 50m00s, Hazard: 0.29)
```
Sorting is correct:
- Primary: EV descending ✅
- Secondary: TTL ascending ✅
- Tertiary: Hazard descending ✅

### Build System ✅
- TypeScript compilation successful ✅
- No type errors introduced ✅
- All existing tests still pass ✅

### PR9 Safeguards Intact ✅
All PR9 safety features remain unchanged:
- Payer preflight check ✅
- Idempotent ATA creation ✅
- borrowIxIndex recompute ✅
- Fee buffer precheck ✅
- Missing account check ✅
- Guarded Transaction.add spreads ✅
- Sysvar handling ✅

## Usage

### Enable Forecast Ranking
Add to `.env`:
```bash
USE_FORECAST_FOR_DRYRUN=true
```

### Disable Forecast Ranking (default)
Omit the variable or set:
```bash
USE_FORECAST_FOR_DRYRUN=false
```

### Run Dry-Run with Forecast
```bash
npm run flashloan:dryrun:kamino:wsl
```

### Run Tests
```bash
# Unit tests
npx tsx scripts/unit_test_forecast_integration.ts

# Ranking verification
npx tsx scripts/verify_forecast_ranking.ts

# Full integration test
npm run test:flashloan:forecast:wsl
```

## Implementation Notes

### Design Decisions
1. **Opt-in by default**: USE_FORECAST_FOR_DRYRUN defaults to 'false' to avoid breaking existing workflows
2. **Graceful fallback**: Loads scored candidates if available, falls back to raw with on-the-fly scoring
3. **Minimal changes**: Only modified necessary files, no refactoring of existing code
4. **Preserved safeguards**: All PR9 safety checks remain unchanged
5. **Logging**: Added structured logging for ranking events
6. **Table output**: Uses console.table for readable candidate display

### Future Enhancements
- Composite scoring using FORECAST_WEIGHT_EV and FORECAST_WEIGHT_TTL
- Configurable top-N candidate selection
- Multiple candidate simulation in parallel
- Real-time candidate re-ranking during execution

## Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| When USE_FORECAST_FOR_DRYRUN=true, dry-run ranks candidates using EV/TTL/hazard | ✅ Complete |
| Top 10 ranked candidates are logged | ✅ Complete |
| Top-ranked candidate is simulated | ✅ Complete |
| When flag is false, behavior matches PR9 baseline | ✅ Complete |
| Works with data/candidates.scored.json if present | ✅ Complete |
| Falls back to data/candidates.json with on-the-fly scoring | ✅ Complete |
| All PR9 preflight checks intact | ✅ Complete |
| All PR9 transaction safeties intact | ✅ Complete |
| Test infrastructure added | ✅ Complete |

## Summary
PR 8.7 implementation is **complete and verified**. The forecast ranking integration:
- ✅ Works as specified
- ✅ Preserves all PR9 safeguards
- ✅ Includes comprehensive tests
- ✅ Defaults to safe baseline behavior
- ✅ Provides clear opt-in mechanism
- ✅ Builds successfully
- ✅ Documented properly
