# PowerShell script to run TTL expiry rules test in WSL
# Usage: powershell -ExecutionPolicy Bypass -File scripts/run_test_ttl_expiry_rules_wsl.ps1

Write-Host "Running TTL expiry rules test in WSL..." -ForegroundColor Cyan
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
wsl bash -c "cd '$($rootDir -replace '\\', '/')' && npx tsx scripts/test_ttl_expiry_rules.ts"
