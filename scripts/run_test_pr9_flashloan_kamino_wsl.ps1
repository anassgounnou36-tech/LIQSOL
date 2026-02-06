# PowerShell script to run PR9 flashloan validation in WSL2

# Force Ubuntu distro for all WSL calls
$Distro = "Ubuntu"

Write-Host "Running PR9 flashloan validation in WSL" -ForegroundColor Cyan
Write-Host ""

Write-Host "Checking for WSL installation..." -ForegroundColor Cyan

# Check if WSL is installed
if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "ERROR: WSL is not installed or not available." -ForegroundColor Red
    Write-Host "Please install WSL2 by running: wsl --install" -ForegroundColor Yellow
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

$wslPath = (& wsl.exe -d $Distro -- wslpath -a "$winPath").Trim()
if ([string]::IsNullOrWhiteSpace($wslPath)) {
    Write-Host ""
    Write-Host "ERROR: Failed to compute WSL path." -ForegroundColor Red
    exit 1
}

Write-Host "WSL path: $wslPath" -ForegroundColor Gray
Write-Host ""

# Check if .env exists
Write-Host "Checking for .env file..." -ForegroundColor Cyan
$envCheck = & wsl.exe -d $Distro -- test -f "$wslPath/.env"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: .env file not found in repository root." -ForegroundColor Red
    exit 1
}

Write-Host ".env file found." -ForegroundColor Green
Write-Host ""

# Install dependencies
Write-Host "Installing dependencies..." -ForegroundColor Cyan
& wsl.exe -d $Distro -- bash -c "cd '$wslPath' && npm install"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: npm install failed." -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host "Dependencies installed." -ForegroundColor Green
Write-Host ""

# Step 1: Run dry-run test for both mints
Write-Host "Step 1: Running flashloan dry-run tests..." -ForegroundColor Cyan

Write-Host "  Testing USDC flashloan..." -ForegroundColor Gray
& wsl.exe -d $Distro -- bash -c "cd '$wslPath' && npm run flashloan:dryrun:kamino -- --mint USDC --amount 1000"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: USDC flashloan dry-run failed." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "  Testing SOL flashloan..." -ForegroundColor Gray
& wsl.exe -d $Distro -- bash -c "cd '$wslPath' && npm run flashloan:dryrun:kamino -- --mint SOL --amount 10"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: SOL flashloan dry-run failed." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "Dry-run tests completed." -ForegroundColor Green
Write-Host ""

# Step 2: Run validator
Write-Host "Step 2: Running flashloan validator..." -ForegroundColor Cyan
& wsl.exe -d $Distro -- bash -c "cd '$wslPath' && npm run test:pr9:flashloan:kamino"
$validatorExitCode = $LASTEXITCODE

if ($validatorExitCode -eq 0) {
    Write-Host ""
    Write-Host "✅ SUCCESS: PR9 flashloan validation passed!" -ForegroundColor Green
    exit 0
} else {
    Write-Host ""
    Write-Host "❌ ERROR: PR9 flashloan validation failed." -ForegroundColor Red
    exit $validatorExitCode
}
