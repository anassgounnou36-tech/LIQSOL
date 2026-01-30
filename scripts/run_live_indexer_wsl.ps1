# PowerShell script to run live:indexer in WSL2
# This script is designed for Windows users who face native binding issues
# To avoid Windows file locks and slow npm installs on /mnt/c, we copy the repo to Linux filesystem

# Force Ubuntu distro for all WSL calls
$Distro = "Ubuntu"

Write-Host "Checking for WSL installation..." -ForegroundColor Cyan

# Check if WSL is installed
if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "ERROR: WSL is not installed or not available." -ForegroundColor Red
    Write-Host "Please install WSL2 by running: wsl --install" -ForegroundColor Yellow
    Write-Host "For more information: https://docs.microsoft.com/en-us/windows/wsl/install" -ForegroundColor Yellow
    exit 1
}

Write-Host "WSL detected." -ForegroundColor Green

# Verify Ubuntu distro exists
Write-Host "Verifying Ubuntu WSL distro..." -ForegroundColor Cyan
$distros = & wsl.exe -l -q 2>$null
if (($distros | ForEach-Object { $_.Trim() }) -notcontains $Distro) {
    Write-Host ""
    Write-Host "ERROR: Ubuntu WSL distro not found." -ForegroundColor Red
    Write-Host "Install it with: wsl --install -d Ubuntu" -ForegroundColor Yellow
    exit 1
}

Write-Host "Ubuntu distro found." -ForegroundColor Green

# Get current directory path and convert to WSL path
$winPath = (Get-Location).Path
Write-Host "Current Windows path: $winPath" -ForegroundColor Gray

$wslSource = (& wsl.exe -d $Distro -- wslpath -a "$winPath").Trim()
if ([string]::IsNullOrWhiteSpace($wslSource)) {
    Write-Host ""
    Write-Host "ERROR: Failed to compute WSL source path." -ForegroundColor Red
    exit 1
}

Write-Host "WSL source path: $wslSource" -ForegroundColor Gray

# Check if .env exists in source
Write-Host "Checking for .env file..." -ForegroundColor Cyan
$envCheck = & wsl.exe -d $Distro -- bash -lc "test -f '$wslSource/.env' && echo 'exists' || echo 'missing'"
if ($envCheck.Trim() -eq 'missing') {
    Write-Host ""
    Write-Host "ERROR: .env file not found in repository root." -ForegroundColor Red
    Write-Host "The live indexer requires environment variables in .env file." -ForegroundColor Yellow
    exit 1
}

Write-Host ".env file found." -ForegroundColor Green
Write-Host ""

# Ask Ubuntu for its HOME reliably (using printf to avoid newline issues)
Write-Host "Setting up Linux workspace..." -ForegroundColor Cyan
$linuxHome = (& wsl.exe -d $Distro -- bash -lc 'printf "%s" "$HOME"').Trim()
if ([string]::IsNullOrWhiteSpace($linuxHome) -or -not $linuxHome.StartsWith("/home/")) {
    Write-Host ""
    Write-Host "ERROR: Failed to determine valid Linux home directory. Got: $linuxHome" -ForegroundColor Red
    exit 1
}

$workspace = "$linuxHome/liqsol-workspace"
Write-Host "Linux workspace: $workspace" -ForegroundColor Gray

# Create workspace directory inside Ubuntu
Write-Host "Creating workspace directory..." -ForegroundColor Cyan
& wsl.exe -d $Distro -- bash -lc "mkdir -p '$workspace'"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Failed to create workspace directory." -ForegroundColor Red
    exit 1
}

# Copy repo using tar pipe (avoids rsync dependency)
Write-Host "Copying repository to Linux filesystem..." -ForegroundColor Cyan
& wsl.exe -d $Distro -- bash -lc "rm -rf '$workspace'/* && (cd '$wslSource' && tar -cf - --exclude=node_modules --exclude=.git --exclude=dist .) | (cd '$workspace' && tar -xf -)"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Failed to copy repository to Linux filesystem." -ForegroundColor Red
    exit 1
}

Write-Host "Repository copied successfully." -ForegroundColor Green

# Copy .env file explicitly
Write-Host "Copying .env file..." -ForegroundColor Cyan
& wsl.exe -d $Distro -- bash -lc "cp -f '$wslSource/.env' '$workspace/.env'"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Failed to copy .env file." -ForegroundColor Red
    exit 1
}

Write-Host ".env copied." -ForegroundColor Green

# Ensure data directory exists and check for obligations.jsonl
Write-Host "Checking for data/obligations.jsonl in WSL workspace..." -ForegroundColor Cyan
& wsl.exe -d $Distro -- bash -lc "mkdir -p '$workspace/data'"

# Check if snapshot file exists in Windows repo first
$dataCheckWindows = & wsl.exe -d $Distro -- bash -lc "test -f '$wslSource/data/obligations.jsonl' && echo 'exists' || echo 'missing'"
if ($dataCheckWindows.Trim() -eq 'exists') {
    Write-Host "Found data/obligations.jsonl in Windows repo, copying..." -ForegroundColor Cyan
    & wsl.exe -d $Distro -- bash -lc "cp -f '$wslSource/data/obligations.jsonl' '$workspace/data/obligations.jsonl'"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "data/obligations.jsonl copied successfully." -ForegroundColor Green
    } else {
        Write-Host "WARNING: Failed to copy data/obligations.jsonl" -ForegroundColor Yellow
    }
}

# Check if obligations.jsonl exists in WSL workspace (after potential copy)
$dataCheckWSL = & wsl.exe -d $Distro -- bash -lc "test -f '$workspace/data/obligations.jsonl' && echo 'exists' || echo 'missing'"

if ($dataCheckWSL.Trim() -eq 'missing') {
    Write-Host "data/obligations.jsonl not found in WSL workspace." -ForegroundColor Yellow
    Write-Host "Running snapshot first to ensure non-empty bootstrap..." -ForegroundColor Cyan
    Write-Host ""
    
    # Run snapshot inside WSL workspace to generate obligations.jsonl
    & wsl.exe -d $Distro -- bash -lc "cd '$workspace' && npm install && npm run snapshot:obligations"
    $snapshotExitCode = $LASTEXITCODE
    
    if ($snapshotExitCode -ne 0) {
        Write-Host ""
        Write-Host "ERROR: Snapshot failed in WSL." -ForegroundColor Red
        exit $snapshotExitCode
    }
    
    # Verify the snapshot file was created and is not empty
    $dataCheckAfterSnapshot = & wsl.exe -d $Distro -- bash -lc "test -f '$workspace/data/obligations.jsonl' && echo 'exists' || echo 'missing'"
    if ($dataCheckAfterSnapshot.Trim() -eq 'exists') {
        Write-Host "Snapshot completed, checking file..." -ForegroundColor Green
        
        # Check if file is empty
        $fileSize = & wsl.exe -d $Distro -- bash -lc "wc -l < '$workspace/data/obligations.jsonl' 2>/dev/null || echo '0'"
        $lineCount = [int]$fileSize.Trim()
        
        if ($lineCount -eq 0) {
            Write-Host ""
            Write-Host "ERROR: Snapshot returned 0 obligations (empty file)." -ForegroundColor Red
            Write-Host "Fix snapshot before running live indexer. Check:" -ForegroundColor Red
            Write-Host "  - Yellowstone endpoint URL and token are correct" -ForegroundColor Red
            Write-Host "  - Network connectivity to Yellowstone" -ForegroundColor Red
            Write-Host "  - Filter configuration (discriminator, program ID)" -ForegroundColor Red
            Write-Host ""
            exit 1
        } else {
            Write-Host "Snapshot file contains $lineCount obligations." -ForegroundColor Green
        }
    } else {
        Write-Host ""
        Write-Host "ERROR: Snapshot ran but obligations.jsonl not found." -ForegroundColor Red
        Write-Host "Fix snapshot before running live indexer." -ForegroundColor Red
        Write-Host ""
        exit 1
    }
} else {
    Write-Host "data/obligations.jsonl found in WSL workspace." -ForegroundColor Green
    
    # Verify the existing file is not empty
    $fileSize = & wsl.exe -d $Distro -- bash -lc "wc -l < '$workspace/data/obligations.jsonl' 2>/dev/null || echo '0'"
    $lineCount = [int]$fileSize.Trim()
    
    if ($lineCount -eq 0) {
        Write-Host ""
        Write-Host "ERROR: Existing obligations.jsonl is empty (0 obligations)." -ForegroundColor Red
        Write-Host "Running snapshot to generate data..." -ForegroundColor Cyan
        Write-Host ""
        
        # Run snapshot to replace empty file
        & wsl.exe -d $Distro -- bash -lc "cd '$workspace' && npm install && npm run snapshot:obligations"
        $snapshotExitCode = $LASTEXITCODE
        
        if ($snapshotExitCode -ne 0) {
            Write-Host ""
            Write-Host "ERROR: Snapshot failed in WSL." -ForegroundColor Red
            exit $snapshotExitCode
        }
        
        # Re-check after snapshot
        $fileSize = & wsl.exe -d $Distro -- bash -lc "wc -l < '$workspace/data/obligations.jsonl' 2>/dev/null || echo '0'"
        $lineCount = [int]$fileSize.Trim()
        
        if ($lineCount -eq 0) {
            Write-Host ""
            Write-Host "ERROR: Snapshot returned 0 obligations." -ForegroundColor Red
            Write-Host "Fix snapshot before running live indexer." -ForegroundColor Red
            Write-Host ""
            exit 1
        } else {
            Write-Host "Snapshot file now contains $lineCount obligations." -ForegroundColor Green
        }
    } else {
        Write-Host "File contains $lineCount obligations." -ForegroundColor Green
    }
}
Write-Host ""

# Install dependencies and run live indexer inside workspace
Write-Host "Installing dependencies and running live indexer..." -ForegroundColor Cyan
Write-Host ""
Write-Host "NOTE: Press Ctrl+C to stop the indexer." -ForegroundColor Yellow
Write-Host ""

& wsl.exe -d $Distro -- bash -lc "cd '$workspace' && npm install && npm run live:indexer"
$indexerExitCode = $LASTEXITCODE

if ($indexerExitCode -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS: Live indexer stopped successfully." -ForegroundColor Green
    exit 0
} else {
    Write-Host ""
    Write-Host "Live indexer exited with code: $indexerExitCode" -ForegroundColor Yellow
    exit $indexerExitCode
}
