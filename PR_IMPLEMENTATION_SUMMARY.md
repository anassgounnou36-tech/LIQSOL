# PR: Small Follow-ups - Liquidatable Priority, Audit Resilience, Mint Labels

## Summary

This PR implements three focused improvements to enhance executor prioritization, audit robustness, and mint label handling:

1. **Liquidatable Priority Bump**: Ensures liquidatable-now obligations always rank first
2. **Audit Pipeline Command**: Provides visibility into the scheduler pipeline with graceful error handling
3. **Mint Resolution Utility**: Standardizes mint label resolution (USDC, SOL, USDT)

## Changes Made

### 1. Liquidatable Priority Bump

**Files Modified:**
- `src/scheduler/txBuilder.ts` - Added `liquidationEligible` field to `FlashloanPlan` interface
- `src/execute/executor.ts` - Updated candidate sorting with liquidation priority
- `src/scheduler/txScheduler.ts` - Updated `enqueuePlans` and `refreshQueue` sorting

**Sorting Logic:**
```typescript
// Priority order:
1. liquidationEligible (true first)
2. ev (descending)
3. ttlMin (ascending)  
4. hazard (descending)
```

**Impact:** Liquidatable obligations now always appear at the top of `data/tx_queue.json`, regardless of EV or TTL values.

### 2. Audit Pipeline Command

**Files Created:**
- `src/commands/auditPipeline.ts` - Audit command with resilient file handling
- `scripts/run_audit_pipeline_wsl.ps1` - PowerShell wrapper for WSL

**Files Modified:**
- `src/scheduler/txFilters.ts` - Added `filterCandidatesWithStats` function
- `package.json` - Added `audit:pipeline` and `audit:pipeline:wsl` scripts

**Features:**
- Reads and reports counts from all pipeline stages:
  - `data/obligations.jsonl` (raw obligations)
  - `data/scored.json` (scored with health ratios)
  - `data/candidates.json` (filtered candidates)
  - `data/tx_queue.json` (final transaction queue)
- Handles missing files gracefully (prints "missing" instead of throwing)
- Shows detailed filter statistics:
  - Rejection reasons (EV too low, TTL too high, hazard too low, missing data)
  - Force-included liquidatable counts

**Usage:**
```bash
npm run audit:pipeline
# or for WSL:
npm run audit:pipeline:wsl
```

### 3. Mint Resolution Utility

**Files Created:**
- `src/utils/mintResolve.ts` - Standardized mint label resolution

**Features:**
- Supports labels: `USDC`, `SOL`, `USDT` (case-insensitive)
- Passes through valid base58 public key strings
- Returns `PublicKey` objects
- Throws clear error messages for invalid inputs

**Example:**
```typescript
import { resolveMint } from './src/utils/mintResolve.js';

const usdcMint = resolveMint('USDC'); // EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
const solMint = resolveMint('SOL');   // So11111111111111111111111111111111111111112
const usdtMint = resolveMint('USDT'); // Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
```

### 4. Documentation Updates

**Files Modified:**
- `.env.example` - Added candidate selection and scheduler configuration variables:
  - `CAND_TOP` - Max candidates to select (default: 50)
  - `CAND_NEAR` - Near-liquidation threshold (default: 1.02)
  - `CAND_VALIDATE_SAMPLES` - Validation sample count (default: 0)
  - `SCHED_MAX_QUEUE_SIZE` - Queue size cap (default: 100)

- `README.md` - Added comprehensive Configuration section documenting:
  - Core settings
  - Scheduler configuration
  - Candidate selection tuning
  - Executor configuration
  - EV calculation parameters

## Testing

### Automated Tests Created

1. **`scripts/test_sorting.ts`** - Verifies liquidatable priority sorting
2. **`scripts/test_mint_resolve.ts`** - Tests mint label resolution
3. **`scripts/test_pr_features.ts`** - Integration test covering all features

### Test Results

✓ Liquidatable priority sorting: Verified liquidatable obligations rank first
✓ Audit pipeline: Handles missing files, shows correct filter statistics
✓ Mint resolution: All labels (USDC, SOL, USDT) resolve correctly
✓ Build: `npm run build` passes with no errors
✓ Lint: No new lint errors introduced
✓ Security: CodeQL analysis found 0 vulnerabilities

### Example Output

**Sorting Test:**
```
Original order:
  1. test1 - liq=true, ev=50, ttl=5, hazard=0.8
  2. test2 - liq=false, ev=100, ttl=3, hazard=0.9
  3. test3 - liq=true, ev=30, ttl=7, hazard=0.7

Sorted order (liquidationEligible first):
  1. test1 - liq=true, ev=50, ttl=5, hazard=0.8
  2. test3 - liq=true, ev=30, ttl=7, hazard=0.7
  3. test2 - liq=false, ev=100, ttl=3, hazard=0.9

✓ PASS: All liquidatable obligations are sorted before non-liquidatable
```

**Audit Pipeline Output:**
```
=== PIPELINE AUDIT ===

Stage Counts:
  data/obligations.jsonl          missing
  data/scored.json                missing
  data/candidates.json                  3
  data/tx_queue.json                    2

Filter Statistics:
  Total candidates:           3
  Filtered (passed):          2
  Rejected (total):           1

  Rejection Reasons:
    EV too low (<= 0):      0
    TTL too high (> 10 min): 1
    Hazard too low (<= 0.05):  0
    Missing health ratio:       0
    Missing borrow value:       0

  Force-Included:
    Liquidatable now:           1
```

## Scope and Constraints

**In Scope:**
- ✅ Liquidatable priority sorting in executor and scheduler
- ✅ Audit command with missing file handling
- ✅ Mint label resolution utility
- ✅ Documentation updates

**Out of Scope (as specified):**
- ❌ Swap sizing changes
- ❌ Broadcast behavior changes
- ❌ Snapshot pipeline format changes
- ❌ Existing script name or behavior modifications

## Code Quality

- **TypeScript Compliance:** All code passes `tsc --noEmit`
- **Linting:** No new ESLint errors introduced
- **Code Review:** All feedback addressed
- **Security:** No vulnerabilities detected by CodeQL

## Acceptance Criteria

✅ **Liquidatable Priority:** liquidationEligible === true candidates always rank above non-liquidatable, with EV/TTL/hazard tie-breakers

✅ **Queue Sorting:** Same priority applied in `data/tx_queue.json`, ensuring liquidatable-now obligations at top

✅ **Audit Command:** Prints counts for each pipeline stage, handles missing files gracefully, shows filter reason stats including forced-in liquidatable counts

✅ **Mint Resolution:** resolveMint covers USDC, SOL, USDT; available for all modules to avoid "Invalid public key input" for labels

✅ **Documentation:** .env.example and README.md updated with new/expanded envs and tuning guidance

## Next Steps

This PR is ready for review and merge. All acceptance criteria met, tests pass, and code quality checks successful.
