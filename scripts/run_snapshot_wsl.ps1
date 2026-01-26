# PowerShell script to run snapshot:obligations in WSL2
# This script is designed for Windows users who face native binding issues

Write-Host "Checking for WSL installation..." -ForegroundColor Cyan

# Check if WSL is installed
$wslCheck = wsl --status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: WSL is not installed or not available." -ForegroundColor Red
    Write-Host "Please install WSL2 by running: wsl --install" -ForegroundColor Yellow
    Write-Host "For more information: https://docs.microsoft.com/en-us/windows/wsl/install" -ForegroundColor Yellow
    exit 1
}

Write-Host "WSL detected." -ForegroundColor Green

# Get current directory path
$currentPath = Get-Location

Write-Host "Converting Windows path to WSL path..." -ForegroundColor Cyan
Write-Host "Current Windows path: $currentPath" -ForegroundColor Gray

# Convert Windows path to WSL path using wslpath
$wslPath = wsl wslpath -u "$currentPath"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Failed to convert path to WSL format." -ForegroundColor Red
    exit 1
}

Write-Host "WSL path: $wslPath" -ForegroundColor Gray
Write-Host ""
Write-Host "Running: npm ci && npm run snapshot:obligations" -ForegroundColor Cyan
Write-Host "This may take a few minutes..." -ForegroundColor Gray
Write-Host ""

# Run npm ci and npm run snapshot:obligations in WSL
# Commands are chained so npm run will only execute if npm ci succeeds
wsl bash -c "cd '$wslPath' && npm ci && npm run snapshot:obligations"

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS: Snapshot completed successfully in WSL." -ForegroundColor Green
    Write-Host "Output file: data/obligations.jsonl" -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "ERROR: Snapshot failed in WSL." -ForegroundColor Red
    exit 1
}
