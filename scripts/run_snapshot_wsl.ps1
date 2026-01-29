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
    Write-Host "The snapshot command requires environment variables in .env file." -ForegroundColor Yellow
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
Write-Host ""

# Install dependencies and run snapshot inside workspace
Write-Host "Installing dependencies and running snapshot..." -ForegroundColor Cyan
Write-Host ""

& wsl.exe -d $Distro -- bash -lc "cd '$workspace' && npm install && npm run snapshot:obligations"
$snapshotExitCode = $LASTEXITCODE

if ($snapshotExitCode -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS: Snapshot completed successfully in WSL." -ForegroundColor Green
    
    # Copy output file back to Windows
    Write-Host "Copying output file back to Windows repo..." -ForegroundColor Cyan
    $outputCheck = & wsl.exe -d $Distro -- bash -lc "test -f '$workspace/data/obligations.jsonl' && echo 'exists' || echo 'missing'"
    
    if ($outputCheck.Trim() -eq 'exists') {
        & wsl.exe -d $Distro -- bash -lc "mkdir -p '$wslSource/data' && cp '$workspace/data/obligations.jsonl' '$wslSource/data/obligations.jsonl'"
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Output file: data/obligations.jsonl" -ForegroundColor Cyan
        } else {
            Write-Host "WARNING: Failed to copy output file back to Windows repo." -ForegroundColor Yellow
        }
    } else {
        Write-Host "WARNING: Output file data/obligations.jsonl not found in Linux workspace." -ForegroundColor Yellow
    }
    exit 0
} else {
    Write-Host ""
    Write-Host "ERROR: Snapshot failed in WSL." -ForegroundColor Red
    exit $snapshotExitCode
}
