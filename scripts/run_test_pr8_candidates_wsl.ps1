# PowerShell script to run PR8 candidate validation in WSL2
# This runs snapshot:candidates followed by validation

# Force Ubuntu distro for all WSL calls
$Distro = "Ubuntu"

Write-Host "Running PR8 candidate validation in WSL" -ForegroundColor Cyan
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

# Step 1: Install dependencies
Write-Host "Step 1: Installing dependencies..." -ForegroundColor Cyan
& wsl.exe -d $Distro -- bash -c "cd '$wslPath' && npm install"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: npm install failed." -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host "Dependencies installed." -ForegroundColor Green
Write-Host ""

# Step 2: Run snapshot:candidates
Write-Host "Step 2: Running snapshot:candidates..." -ForegroundColor Cyan
& wsl.exe -d $Distro -- bash -c "cd '$wslPath' && npm run snapshot:candidates"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: snapshot:candidates failed." -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host "Candidate selection completed." -ForegroundColor Green
Write-Host ""

# Step 3: Run validator
Write-Host "Step 3: Running candidate validator..." -ForegroundColor Cyan
& wsl.exe -d $Distro -- bash -c "cd '$wslPath' && npm run test:pr8:candidates"
$validatorExitCode = $LASTEXITCODE

if ($validatorExitCode -eq 0) {
    Write-Host ""
    Write-Host "✅ SUCCESS: PR8 candidate validation passed!" -ForegroundColor Green
    exit 0
} else {
    Write-Host ""
    Write-Host "❌ ERROR: PR8 candidate validation failed." -ForegroundColor Red
    exit $validatorExitCode
}
