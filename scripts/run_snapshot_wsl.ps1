# PowerShell script to run snapshot:obligations in WSL2
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

# Get current directory path
$currentPath = (Get-Location).Path

Write-Host "Converting Windows path to WSL path..." -ForegroundColor Cyan
Write-Host "Current Windows path: $currentPath" -ForegroundColor Gray

# Convert Windows path to WSL path using wslpath directly (handles spaces correctly)
$wslSourcePath = & wsl.exe -d $Distro -- wslpath -a "$currentPath"
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($wslSourcePath)) {
    Write-Host ""
    Write-Host "ERROR: Failed to convert path to WSL format (wslpath returned empty)." -ForegroundColor Red
    exit 1
}

# Trim whitespace from wslSourcePath
$wslSourcePath = $wslSourcePath.Trim()

Write-Host "WSL source path: $wslSourcePath" -ForegroundColor Gray

# Check if .env exists in source
Write-Host "Checking for .env file in Windows repo..." -ForegroundColor Cyan
$envCheckResult = wsl.exe -d $Distro -- bash -lc "cd '$wslSourcePath' && test -f .env && echo 'exists' || echo 'missing'"
if ($envCheckResult.Trim() -eq 'missing') {
    Write-Host ""
    Write-Host "ERROR: .env file not found in repository root." -ForegroundColor Red
    Write-Host "The snapshot command requires environment variables in .env file." -ForegroundColor Yellow
    exit 1
}

Write-Host ".env file found." -ForegroundColor Green
Write-Host ""

# Define target path on Linux filesystem (avoids Windows file locks and improves performance)
Write-Host "Setting up workspace on Linux filesystem..." -ForegroundColor Cyan
$linuxWorkspacePath = "~/liqsol-workspace"

# Create workspace directory and sync repo files
Write-Host "Copying repository to Linux filesystem: $linuxWorkspacePath" -ForegroundColor Cyan
wsl.exe -d $Distro -- bash -lc "mkdir -p $linuxWorkspacePath && rsync -a --delete --exclude='node_modules' --exclude='.git' --exclude='dist' '$wslSourcePath/' '$linuxWorkspacePath/'"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Failed to copy repository to Linux filesystem." -ForegroundColor Red
    exit 1
}

Write-Host "Repository copied successfully." -ForegroundColor Green

# Copy .env file (sync it each run)
Write-Host "Syncing .env file..." -ForegroundColor Cyan
wsl.exe -d $Distro -- bash -lc "cp '$wslSourcePath/.env' '$linuxWorkspacePath/.env'"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Failed to copy .env file." -ForegroundColor Red
    exit 1
}

Write-Host ".env synced." -ForegroundColor Green
Write-Host ""

# Check if node_modules exists in Linux workspace
Write-Host "Checking dependencies in Linux workspace..." -ForegroundColor Cyan
$nodeModulesCheck = wsl.exe -d $Distro -- bash -lc "cd $linuxWorkspacePath && test -d node_modules && echo 'exists' || echo 'missing'"

if ($nodeModulesCheck.Trim() -eq 'missing') {
    Write-Host "Installing dependencies (npm install)..." -ForegroundColor Cyan
    wsl.exe -d $Distro -- bash -lc "cd $linuxWorkspacePath && npm install"
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "ERROR: npm install failed in WSL." -ForegroundColor Red
        exit 1
    }
    Write-Host "Dependencies installed successfully." -ForegroundColor Green
} else {
    Write-Host "Dependencies already installed, skipping npm install..." -ForegroundColor Gray
}

Write-Host ""
Write-Host "Running: npm run snapshot:obligations" -ForegroundColor Cyan
Write-Host ""

# Run snapshot command in WSL from Linux filesystem
wsl.exe -d $Distro -- bash -lc "cd $linuxWorkspacePath && node -v && npm -v && npm run snapshot:obligations"

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS: Snapshot completed successfully in WSL." -ForegroundColor Green
    
    # Copy output file back to Windows
    Write-Host "Copying output file back to Windows repo..." -ForegroundColor Cyan
    wsl.exe -d $Distro -- bash -lc "mkdir -p '$wslSourcePath/data' && cp '$linuxWorkspacePath/data/obligations.jsonl' '$wslSourcePath/data/obligations.jsonl'"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Output file: data/obligations.jsonl" -ForegroundColor Cyan
    } else {
        Write-Host "WARNING: Failed to copy output file back to Windows repo." -ForegroundColor Yellow
    }
    exit 0
} else {
    Write-Host ""
    Write-Host "ERROR: Snapshot failed in WSL." -ForegroundColor Red
    exit 1
}
