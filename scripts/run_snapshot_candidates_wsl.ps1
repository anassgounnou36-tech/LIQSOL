# PowerShell script to run snapshot:candidates in WSL2
# This script is designed for Windows users who face native binding issues
# Runs directly from the current directory in WSL (no workspace copying needed)

Param(
  [string]$Top = "50",
  [string]$Near = "1.02",
  [string]$Validate = "5"
)

# Force Ubuntu distro for all WSL calls
$Distro = "Ubuntu"

Write-Host "PR8 WSL runner: snapshot:candidates" -ForegroundColor Cyan
Write-Host "Parameters: --top=$Top --near=$Near --validate-samples=$Validate" -ForegroundColor Gray
Write-Host ""

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

$wslPath = (& wsl.exe -d $Distro -- wslpath -a "$winPath").Trim()
if ([string]::IsNullOrWhiteSpace($wslPath)) {
    Write-Host ""
    Write-Host "ERROR: Failed to compute WSL path." -ForegroundColor Red
    exit 1
}

Write-Host "WSL path: $wslPath" -ForegroundColor Gray

# Check if .env exists
Write-Host "Checking for .env file..." -ForegroundColor Cyan
$envCheck = & wsl.exe -d $Distro -- test -f "$wslPath/.env"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: .env file not found in repository root." -ForegroundColor Red
    Write-Host "The snapshot:candidates command requires environment variables in .env file." -ForegroundColor Yellow
    exit 1
}

Write-Host ".env file found." -ForegroundColor Green
Write-Host ""

# Check for obligations snapshot data
Write-Host "Checking for data/obligations.jsonl..." -ForegroundColor Cyan
$dataCheck = & wsl.exe -d $Distro -- test -f "$wslPath/data/obligations.jsonl"

if ($LASTEXITCODE -ne 0) {
    Write-Host "data/obligations.jsonl not found." -ForegroundColor Yellow
    Write-Host "You need to run 'npm run snapshot:obligations' first to generate obligation data." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Running snapshot:obligations now..." -ForegroundColor Cyan
    Write-Host ""
    
    # Run snapshot to generate obligations.jsonl
    & wsl.exe -d $Distro -- bash -c "cd '$wslPath' && npm install && npm run snapshot:obligations"
    $snapshotExitCode = $LASTEXITCODE
    
    if ($snapshotExitCode -ne 0) {
        Write-Host ""
        Write-Host "ERROR: Snapshot failed." -ForegroundColor Red
        Write-Host "Cannot run snapshot:candidates without obligation data." -ForegroundColor Red
        exit $snapshotExitCode
    }
    
    # Verify the snapshot file was created
    $dataCheckAfter = & wsl.exe -d $Distro -- test -f "$wslPath/data/obligations.jsonl"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Snapshot completed successfully." -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "ERROR: Snapshot ran but obligations.jsonl not found." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "data/obligations.jsonl found." -ForegroundColor Green
}
Write-Host ""

# Install dependencies and run snapshot:candidates
Write-Host "Running snapshot:candidates in WSL..." -ForegroundColor Cyan
Write-Host ""

& wsl.exe -d $Distro -- bash -c "cd '$wslPath' && npm install && npm run snapshot:candidates -- --top=$Top --near=$Near --validate-samples=$Validate"
$candidatesExitCode = $LASTEXITCODE

if ($candidatesExitCode -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS: Candidate selection completed successfully." -ForegroundColor Green
    exit 0
} else {
    Write-Host ""
    Write-Host "ERROR: Candidate selection failed." -ForegroundColor Red
    exit $candidatesExitCode
}
