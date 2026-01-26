# PowerShell script to run snapshot:obligations in WSL2
# This script is designed for Windows users who face native binding issues

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

# Get current directory path
$currentPath = (Get-Location).Path

Write-Host "Converting Windows path to WSL path..." -ForegroundColor Cyan
Write-Host "Current Windows path: $currentPath" -ForegroundColor Gray

# Convert Windows path to WSL path using wslpath inside WSL (handles spaces correctly)
$wslPath = wsl.exe -e bash -lc "wslpath -u '$($currentPath -replace '\\', '/')'"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Failed to convert path to WSL format." -ForegroundColor Red
    exit 1
}

# Trim whitespace from wslPath
$wslPath = $wslPath.Trim()

Write-Host "WSL path: $wslPath" -ForegroundColor Gray
Write-Host ""

# Check if .env exists
Write-Host "Checking for .env file..." -ForegroundColor Cyan
$envCheckResult = wsl.exe -e bash -lc "cd '$wslPath' && test -f .env && echo 'exists' || echo 'missing'"
if ($envCheckResult.Trim() -eq 'missing') {
    Write-Host "WARNING: .env file not found in repository root." -ForegroundColor Yellow
    Write-Host "The snapshot command may fail without required environment variables." -ForegroundColor Yellow
}

# Check if node_modules exists and detect platform mismatch
Write-Host "Checking dependencies..." -ForegroundColor Cyan
$nodeModulesCheck = wsl.exe -e bash -lc "cd '$wslPath' && test -d node_modules && echo 'exists' || echo 'missing'"

if ($nodeModulesCheck.Trim() -eq 'exists') {
    # Check for Windows-specific native bindings that won't work in WSL
    Write-Host "Checking for Windows-specific native bindings..." -ForegroundColor Cyan
    $win32BindingsCheck = wsl.exe -e bash -lc "cd '$wslPath' && (test -d node_modules/@esbuild/win32-x64 || test -d node_modules/@triton-one/yellowstone-grpc/node_modules/*/win32-x64) && echo 'found' || echo 'not_found'"
    
    if ($win32BindingsCheck.Trim() -eq 'found') {
        Write-Host "Windows-specific bindings detected. Removing node_modules to reinstall for Linux..." -ForegroundColor Yellow
        wsl.exe -e bash -lc "cd '$wslPath' && rm -rf node_modules package-lock.json"
        Write-Host "Installing Linux-native dependencies (npm install)..." -ForegroundColor Cyan
        wsl.exe -e bash -lc "cd '$wslPath' && npm install"
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "ERROR: npm install failed in WSL." -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "Dependencies already installed with correct platform bindings, skipping reinstall..." -ForegroundColor Gray
    }
} else {
    Write-Host "Installing dependencies (npm install)..." -ForegroundColor Cyan
    wsl.exe -e bash -lc "cd '$wslPath' && npm install"
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "ERROR: npm install failed in WSL." -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "Running: npm run snapshot:obligations" -ForegroundColor Cyan
Write-Host ""

# Run snapshot command in WSL
wsl.exe -e bash -lc "cd '$wslPath' && node -v && npm -v && npm run snapshot:obligations"

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS: Snapshot completed successfully in WSL." -ForegroundColor Green
    Write-Host "Output file: data/obligations.jsonl" -ForegroundColor Cyan
    exit 0
} else {
    Write-Host ""
    Write-Host "ERROR: Snapshot failed in WSL." -ForegroundColor Red
    exit 1
}
