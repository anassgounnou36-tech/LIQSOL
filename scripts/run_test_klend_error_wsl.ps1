# PowerShell script to run test_decode_klend_error.ts in WSL
# WSL wrapper for test:klend:error npm script

Write-Host "Running Kamino error decoder test in WSL..." -ForegroundColor Cyan

wsl npm run test:klend:error

if ($LASTEXITCODE -ne 0) {
    Write-Host "Test failed with exit code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "Test completed successfully" -ForegroundColor Green
