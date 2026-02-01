# Using snapshot:scored:wsl Command

## Overview
The `npm run snapshot:scored:wsl` command allows Windows users to run the health ratio scoring tool via WSL, avoiding native binding issues with Yellowstone gRPC.

## Prerequisites
1. **WSL2 installed** - Run `wsl --install` if not already installed
2. **Ubuntu distro** - Run `wsl --install -d Ubuntu` if needed
3. **.env file** - Must exist in repository root with required environment variables

## Usage

From Windows CMD or PowerShell:
```bash
npm run snapshot:scored:wsl
```

## What It Does

1. **Validates Environment**
   - Checks WSL is installed
   - Verifies Ubuntu distro exists
   - Confirms .env file is present

2. **Prepares Workspace**
   - Copies repository to Linux filesystem (`~/liqsol-workspace`)
   - Avoids Windows file lock issues
   - Copies .env file to workspace

3. **Ensures Obligation Data**
   - Checks for `data/obligations.jsonl`
   - If missing, automatically runs `npm run snapshot:obligations` first
   - Validates snapshot contains obligations

4. **Runs Health Scoring**
   - Installs dependencies in Linux workspace
   - Executes `npm run snapshot:scored`
   - Displays scoring results

## Output

The command will display:
- Status messages in color (Cyan, Green, Yellow, Red)
- Progress of each step
- Scored obligations table with health ratios
- Liquidation eligibility for each position

Example output:
```
=== TOP RISKY OBLIGATIONS ===

Rank | Health Ratio | Liquidatable | Borrow Value | Collateral Value | Deposits | Borrows | Obligation
-----------------------------------------------------------------------------------
   1 |       0.7543 | YES          |     $1234.56 |          $930.45 |        2 |       1 | 5ZqK...
   2 |       0.8912 | YES          |      $567.89 |          $506.12 |        1 |       1 | 7aBc...
```

## Comparison with Other Commands

| Command | Purpose | WSL Wrapper |
|---------|---------|-------------|
| `snapshot:obligations` | Fetch all obligations | `snapshot:obligations:wsl` |
| `snapshot:scored` | Score obligations by health | `snapshot:scored:wsl` ✨ NEW |
| `live:indexer` | Real-time monitoring | `live:indexer:wsl` |

## Troubleshooting

### WSL Not Found
```
ERROR: WSL is not installed or not available.
```
**Solution:** Install WSL with `wsl --install`

### Ubuntu Distro Missing
```
ERROR: Ubuntu WSL distro not found.
```
**Solution:** Install Ubuntu with `wsl --install -d Ubuntu`

### .env File Missing
```
ERROR: .env file not found in repository root.
```
**Solution:** Copy `.env.example` to `.env` and configure your environment variables

### No Obligation Data
The script will automatically run `snapshot:obligations` first if `data/obligations.jsonl` is missing.

## Technical Details

**Script Location:** `scripts/run_snapshot_scored_wsl.ps1`

**Key Features:**
- Copies repo to `~/liqsol-workspace` in Linux filesystem
- Excludes `node_modules`, `.git`, and `dist` folders (faster copy)
- Automatically handles obligation snapshot dependency
- Provides detailed error messages and status updates
- Uses PowerShell colors for better readability

**Exit Codes:**
- `0` - Success
- `1` - WSL/Ubuntu not installed, .env missing, or general error
- Other - Command failed with specific error code
