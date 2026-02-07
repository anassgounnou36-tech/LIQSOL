# PowerShell script to run flashloan dry-run forecast test in WSL
# Usage: powershell -ExecutionPolicy Bypass -File scripts/run_test_flashloan_forecast_wsl.ps1

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "  Flashloan Dry-Run Forecast Ranking Test (WSL)" -ForegroundColor Cyan
Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host ""

# Check if WSL is available
$wslCheck = wsl --list --quiet 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: WSL is not available on this system." -ForegroundColor Red
    Write-Host "Please install WSL or run the test script directly with:" -ForegroundColor Yellow
    Write-Host "  npm run test:flashloan:forecast" -ForegroundColor Yellow
    exit 1
}

Write-Host "✓ WSL detected" -ForegroundColor Green
Write-Host ""

# Get the current directory path in WSL format
$currentDir = Get-Location
$wslPath = wsl wslpath -a "'$currentDir'"

Write-Host "Working directory: $currentDir" -ForegroundColor Gray
Write-Host "WSL path: $wslPath" -ForegroundColor Gray
Write-Host ""

# Run the test script in WSL
Write-Host "Running test script in WSL..." -ForegroundColor Cyan
Write-Host ""

wsl bash -c "cd '$wslPath' && tsx scripts/test_flashloan_dryrun_with_forecast.ts"

$exitCode = $LASTEXITCODE

Write-Host ""
Write-Host "=====================================================================" -ForegroundColor Cyan

if ($exitCode -eq 0) {
    Write-Host "✓ Test completed successfully!" -ForegroundColor Green
} else {
    Write-Host "✗ Test failed with exit code: $exitCode" -ForegroundColor Red
}

Write-Host "=====================================================================" -ForegroundColor Cyan

exit $exitCode
