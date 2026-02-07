# PR 8.5: EV-Based Ranking Usage Guide

## Overview

PR 8.5 introduces an opt-in predictive scoring system for liquidations using Expected Value (EV) analysis. This feature allows the bot to rank liquidation candidates by profitability rather than just urgency.

## Quick Start

### 1. Enable EV Ranking

Add to your `.env` file:

```bash
USE_EV_RANKING=true
```

### 2. Configure EV Parameters (Optional)

Default values are provided, but you can tune them:

```bash
# Minimum borrow size to consider (unless liquidatable)
MIN_BORROW_USD=10

# Hazard function smoothing parameter (higher = steeper transition)
HAZARD_ALPHA=25

# Liquidation parameters
EV_CLOSE_FACTOR=0.5              # Fraction of debt that can be closed
EV_LIQUIDATION_BONUS_PCT=0.05    # 5% liquidation bonus
EV_FLASHLOAN_FEE_PCT=0.002       # 0.2% flashloan fee
EV_FIXED_GAS_USD=0.5             # Fixed gas cost in USD
EV_SLIPPAGE_BUFFER_PCT=0.005     # Optional: 0.5% slippage buffer
```

## How It Works

### Default Mode (USE_EV_RANKING=false)

- Ranks by **urgency** × **size**
- Liquidatable accounts get massive priority boost
- Near-threshold accounts ranked by distance to liquidation

### EV Mode (USE_EV_RANKING=true)

1. **Hazard Score Calculation**
   - Based on health ratio: `hazard = 1 / (1 + alpha * margin)`
   - Where `margin = max(0, healthRatio - 1.0)`
   - Score of 1.0 = highest risk, 0.0 = lowest risk

2. **Expected Value Calculation**
   - `EV = (hazard × profit) - cost`
   - `profit = closeFactor × liquidationBonusPct × borrowValueUsd`
   - `cost = variableFees + fixedGasUsd`

3. **Ranking**
   - Candidates sorted by EV descending
   - Filters out small positions (< MIN_BORROW_USD) unless liquidatable
   - Uses healthRatioRaw when available for more precise calculations

## Testing

### Run the Test Harness

```bash
# Generate candidate data first
npm run snapshot:candidates:wsl

# Test EV ranking
npm run test:prediction:pr85:wsl
```

The test script will:
- Read `data/candidates.json`
- Log EV parameters and constants
- Display top-10 candidates with hazard/EV scores

### Run Unit Tests

```bash
npm test test/candidate-selector.test.ts
```

## Tuning Guide

### HAZARD_ALPHA
- **Higher values (50-100)**: Steeper transition, more conservative
- **Lower values (10-25)**: Smoother transition, more aggressive
- **Default: 25** - Balanced approach

### MIN_BORROW_USD
- Set based on gas costs and minimum profitable liquidation
- Too low: waste gas on unprofitable liquidations
- Too high: miss opportunities
- **Default: 10** - Works for most scenarios

### EV Parameters
- Match your actual liquidation setup
- `EV_CLOSE_FACTOR`: Protocol-specific (usually 0.5)
- `EV_LIQUIDATION_BONUS_PCT`: Protocol liquidation incentive
- `EV_FLASHLOAN_FEE_PCT`: Your flashloan provider's fee
- `EV_FIXED_GAS_USD`: Average gas cost in USD
- `EV_SLIPPAGE_BUFFER_PCT`: Safety margin for price movement

## Example Scenarios

### Conservative Strategy
```bash
USE_EV_RANKING=true
HAZARD_ALPHA=50           # Steeper transition
MIN_BORROW_USD=100        # Larger positions only
EV_FIXED_GAS_USD=1.0      # Higher gas estimate
```

### Aggressive Strategy
```bash
USE_EV_RANKING=true
HAZARD_ALPHA=15           # Smoother transition
MIN_BORROW_USD=10         # Smaller positions OK
EV_FIXED_GAS_USD=0.3      # Lower gas estimate
```

## Integration with Existing Code

EV ranking integrates seamlessly with existing PR8 flows:

```typescript
import { selectCandidates } from './strategy/candidateSelector.js';

// Get scored obligations from indexer
const scored = indexer.getScoredObligations();

// Option 1: Default PR8 behavior
const candidates = selectCandidates(scored);

// Option 2: EV-based ranking
const candidates = selectCandidates(scored, {
  useEvRanking: true,
  minBorrowUsd: 10,
  hazardAlpha: 25,
  evParams: {
    closeFactor: 0.5,
    liquidationBonusPct: 0.05,
    flashloanFeePct: 0.002,
    fixedGasUsd: 0.5,
  },
});

// Candidates now include hazard and ev fields
candidates.forEach(c => {
  console.log(`${c.obligationPubkey}: EV = ${c.ev}, Hazard = ${c.hazard}`);
});
```

## Comparison: Default vs EV Ranking

| Aspect | Default (PR8) | EV Ranking (PR8.5) |
|--------|---------------|-------------------|
| **Priority** | Urgency-based | Profitability-based |
| **Liquidatable** | Always top priority | Weighted by size & bonus |
| **Near-threshold** | High priority | Depends on expected profit |
| **Large safe positions** | Low priority | May rank high if profitable |
| **Small risky positions** | Filtered by urgency | Filtered by MIN_BORROW_USD |

## Troubleshooting

### "Missing data/candidates.json"
Run: `npm run snapshot:candidates:wsl`

### Tests fail after enabling EV ranking
Ensure evParams are provided when useEvRanking is true

### EV values seem wrong
- Verify gas cost estimate (EV_FIXED_GAS_USD)
- Check liquidation bonus matches protocol
- Review flashloan fee percentage

## Technical Details

### Module Structure
```
src/predict/
  ├── hazardScorer.ts    # Hazard score calculation
  └── evCalculator.ts    # Expected value calculation

scripts/
  ├── test_prediction_pr85.ts           # Test harness
  └── run_test_prediction_pr85_wsl.ps1  # WSL runner
```

### Type Definitions
```typescript
interface EvParams {
  closeFactor: number;
  liquidationBonusPct: number;
  flashloanFeePct: number;
  fixedGasUsd: number;
  slippageBufferPct?: number;
}

interface Candidate extends ScoredObligation {
  hazard?: number;  // 0-1 risk score
  ev?: number;      // Expected value in USD
  // ... other fields
}
```

## Performance Notes

- EV calculation adds minimal overhead (<1ms per candidate)
- No additional RPC calls required
- Compatible with all existing caching and streaming features
- Can be toggled without code changes via .env

## Future Enhancements

Potential improvements for future PRs:
- Machine learning for hazard score calibration
- Dynamic parameter adjustment based on market conditions
- Multi-objective optimization (EV + urgency)
- Historical profitability tracking and validation
