# PR8: Liquidation Candidate Selector Implementation

## Overview

PR8 implements a candidate selection and ranking system for liquidation monitoring. It builds on PR7's scoring infrastructure to identify and prioritize obligations that are liquidatable or near the liquidation threshold.

## Components

### 1. Candidate Selector Module (`src/strategy/candidateSelector.ts`)

The core module that ranks scored obligations by priority:

- **Priority Scoring**: Liquidatable accounts get massive boost (10,000+), near-liquidation accounts ranked by distance, with size bonus based on borrow value
- **Distance to Liquidation**: Tracks `max(0, healthRatio - 1)` for each obligation
- **Near-Threshold Detection**: Flags accounts predicted to be liquidatable soon (default: HR ≤ 1.02)

#### Interfaces

```typescript
interface ScoredObligation {
  obligationPubkey: string;
  ownerPubkey: string;
  healthRatio: number;
  liquidationEligible: boolean;
  borrowValueUsd: number;
  collateralValueUsd: number;
}

interface Candidate extends ScoredObligation {
  priorityScore: number;
  distanceToLiquidation: number;
  predictedLiquidatableSoon: boolean;
  priceMoveToLiquidationPct?: number; // optional
}
```

### 2. Snapshot Candidates Command (`src/commands/snapshotCandidates.ts`)

CLI tool that:
- Loads reserves and oracles from RPC
- Bootstraps scored obligations using `LiveObligationIndexer`
- Selects and ranks candidates
- Prints top N to console
- Writes machine-readable JSON to `data/candidates.json`
- Supports optional validation samples with detailed health breakdowns

#### Usage

```bash
# Direct execution
npm run snapshot:candidates -- --top=50 --near=1.02 --validate-samples=5

# WSL-friendly (for Windows users)
npm run snapshot:candidates:wsl
```

#### Arguments

- `--top=N`: Number of top candidates to include (default: 50)
- `--near=RATIO`: Near-threshold ratio for prediction (default: 1.02)
- `--validate-samples=N`: Show detailed breakdown for first N candidates (default: 0)

### 3. Health Breakdown Module (`src/math/healthBreakdown.ts`)

Provides detailed validation output showing:
- Per-leg USD breakdowns for deposits and borrows
- Price inputs (oracle prices converted to USD)
- Thresholds/factors applied (liquidation threshold, borrow factor)
- Totals and final health ratio
- Flags for allowlist mode, missing data, approximations

#### Output Structure

```typescript
interface HealthBreakdown {
  deposits: HealthBreakdownLeg[];
  borrows: HealthBreakdownLeg[];
  totals: {
    collateralUsdRaw: number;
    collateralUsdAdj: number;
    borrowUsdRaw: number;
    borrowUsdAdj: number;
    healthRatio: number;
  };
  flags: {
    allowlist: boolean;
    missingLegs: number;
    approximations: string[];
  };
}
```

### 4. Validator Script (`scripts/validate_candidates.ts`)

Automated validation that ensures:
- `data/candidates.json` exists and is valid JSON
- All candidates have required fields with finite numeric values
- Candidates are sorted by `priorityScore` descending
- Liquidatable accounts have higher priority than non-liquidatable
- No NaN/Infinity values in key fields

#### Usage

```bash
# Direct execution
npm run test:pr8:candidates

# WSL-friendly (for Windows users)
npm run test:pr8:candidates:wsl
```

### 5. WSL Runner Scripts

PowerShell scripts for Windows/WSL environments:

- `scripts/run_snapshot_candidates_wsl.ps1`: Runs candidate selection in WSL
- `scripts/run_test_pr8_candidates_wsl.ps1`: Runs full validation workflow

Both scripts:
- Check for WSL and Ubuntu distro
- Verify `.env` file exists
- Optionally auto-generate `data/obligations.jsonl` if missing
- Run npm install
- Execute the command in WSL environment

## Output Format

### Console Output

```
=== PR8 CANDIDATE SELECTION ===

Rank | Priority     | Distance | Liquidatable | Near Threshold | Borrow Value | Collateral Value | Health Ratio | Obligation
----------------------------------------------------------------------------------------------------------------------------------
   1 |    10003.73  |  0.0000  | YES          | NO             |    $5432.10  |        $5173.45  |      0.9523  | BwmMk...
   2 |      747.69  |  0.0134  | NO           | YES            |   $12345.67  |       $12510.89  |      1.0134  | 9vQ8H...
   3 |       15.02  |  0.0876  | NO           | NO             |    $3210.45  |        $3491.67  |      1.0876  | FkL9p...
```

### JSON Output (`data/candidates.json`)

```json
{
  "candidates": [
    {
      "obligationPubkey": "...",
      "ownerPubkey": "...",
      "healthRatio": 0.9523,
      "liquidationEligible": true,
      "borrowValueUsd": 5432.10,
      "collateralValueUsd": 5173.45,
      "priorityScore": 10003.7352,
      "distanceToLiquidation": 0,
      "predictedLiquidatableSoon": false
    }
  ]
}
```

## Priority Scoring Algorithm

```typescript
distance = max(0, healthRatio - 1)
base = (liquidationEligible ? 10_000 : 0) + 1 / (distance + 0.001)
size = log10(max(1, borrowValueUsd))
priorityScore = base + size
```

**Rationale**:
- Liquidatable accounts (HR < 1) get huge boost: 10,000+
- Non-liquidatable ranked by distance: closer = higher priority
- Size factor prevents small positions from dominating
- Results in deterministic, explainable ranking

## Testing

### Unit Tests

```bash
npm test -- test/candidate-selector.test.ts
```

Tests cover:
- Liquidatable prioritization
- Distance calculation
- Near-threshold detection
- Priority sorting
- Non-finite value filtering
- Size bonus logic

### Integration Test

```bash
# Create test data
mkdir -p data
echo '{ "candidates": [...] }' > data/candidates.json

# Run validator
npm run test:pr8:candidates
```

## Dependencies

- Builds on PR7's `LiveObligationIndexer` for scored obligations
- Uses existing reserve/oracle caching infrastructure
- Compatible with SOL/USDC gate (allowlist mode)

## Environment Variables

Inherits from PR7:
- `KAMINO_MARKET_PUBKEY`: Market to query
- `KAMINO_KLEND_PROGRAM_ID`: Program ID
- `RPC_PRIMARY`: Solana RPC endpoint
- `LIQSOL_LIQ_MINT_ALLOWLIST`: Optional mint allowlist (default: SOL+USDC)

## Acceptance Criteria (Met)

✅ Running `npm run snapshot:candidates:wsl -- --top=50 --near=1.02 --validate-samples=5` produces stable candidate list and writes `data/candidates.json`

✅ `npm run test:pr8:candidates:wsl` passes: file exists, non-empty, sorted by priorityScore, no NaN/Infinity, selection rules respected

✅ Validation samples show per-leg USD, price inputs, thresholds/factors, and totals aligned with PR7 health math

## Future Enhancements

- `priceMoveToLiquidationPct`: Add price-move heuristic for SOL/USDC pairs
- Real-time streaming: Integrate with Yellowstone updates
- Historical tracking: Trend analysis for distance-to-liquidation
- Notification system: Alerts for near-threshold accounts
