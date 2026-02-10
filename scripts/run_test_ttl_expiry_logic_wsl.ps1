# PowerShell wrapper for test_ttl_expiry_logic.ts
# Ensures .env is loaded from WSL-accessible path

$ErrorActionPreference = "Stop"

Write-Host "Running TTL expiry logic tests..." -ForegroundColor Cyan

try {
    # Get the current directory in WSL format
    $currentDir = (Get-Location).Path
    $wslPath = $currentDir -replace '\\', '/' -replace '^([A-Z]):', { "/mnt/$($_.Groups[1].Value.ToLower())" }
    
    # Run the test script
    wsl bash -c "cd '$wslPath' && npx tsx scripts/test_ttl_expiry_logic.ts"
    
    Write-Host "`n✓ Tests completed" -ForegroundColor Green
} catch {
    Write-Host "`n✗ Tests failed: $_" -ForegroundColor Red
    exit 1
}
