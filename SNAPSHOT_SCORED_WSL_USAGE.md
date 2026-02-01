# Using snapshot:scored:wsl Command

## Overview
The `npm run snapshot:scored:wsl` command allows Windows users to run the health ratio scoring tool via WSL, avoiding native binding issues with Yellowstone gRPC.

**Updated:** This command now runs directly from your current directory in WSL (no workspace copying needed), making it simpler and more reliable.

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

2. **Checks for Obligation Data**
   - Looks for `data/obligations.jsonl` in current directory
   - If missing, automatically runs `npm run snapshot:obligations` first

3. **Runs Health Scoring**
   - Installs dependencies if needed
   - Executes `npm run snapshot:scored` in WSL
   - Displays scoring results

**Note:** The script runs directly from your Windows directory via WSL mount (e.g., `/mnt/c/...`). It does NOT copy files to a workspace, making it faster and more reliable.

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

| Command | Purpose | WSL Wrapper | Approach |
|---------|---------|-------------|----------|
| `snapshot:obligations` | Fetch all obligations | `snapshot:obligations:wsl` | Copies to workspace |
| `snapshot:scored` | Score obligations by health | `snapshot:scored:wsl` ✅ | Runs directly in place |
| `live:indexer` | Real-time monitoring | `live:indexer:wsl` | Copies to workspace |

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
The script will automatically run `npm run snapshot:obligations` if `data/obligations.jsonl` is missing. This will be done in WSL to ensure native bindings work properly.

### Workspace Directory Error (Fixed)
**Previous Issue:** "ERROR: Failed to create workspace directory"

**Fixed in latest version:** The script no longer uses a workspace directory. It runs directly from your current directory, eliminating this error completely.

## Technical Details

**Script Location:** `scripts/run_snapshot_scored_wsl.ps1`

**Key Changes (Latest Version):**
- Runs directly from Windows mount path in WSL (e.g., `/mnt/c/Users/...`)
- No workspace directory creation or file copying
- Uses `bash -c` for reliable command execution
- Direct `test` commands for file existence checks
- Simplified from 167 to 110 lines

**Key Features:**
- Validates WSL and Ubuntu installation
- Checks for .env file
- Automatically handles obligation snapshot dependency
- Provides detailed status messages
- Uses PowerShell colors for better readability
- No file copying overhead (faster execution)

**Exit Codes:**
- `0` - Success
- `1` - WSL/Ubuntu not installed, .env missing, or general error
- Other - Command failed with specific error code

## Performance

**Previous Version:**
- Created workspace directory
- Copied entire repo with tar (excluding node_modules, .git, dist)
- Ran commands in workspace
- Time: ~30-60 seconds for copy + run

**Current Version:**
- Runs directly from current directory
- No copying needed
- Time: Just the command execution time (~10-30 seconds)

**Result:** Approximately 2-3x faster!
