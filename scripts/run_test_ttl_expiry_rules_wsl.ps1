# PowerShell script to run TTL expiry rules test in WSL
# Usage: powershell -ExecutionPolicy Bypass -File scripts/run_test_ttl_expiry_rules_wsl.ps1

Write-Host "Running TTL expiry rules test in WSL..." -ForegroundColor Cyan
wsl bash -c "cd /home/runner/work/LIQSOL/LIQSOL && npx tsx scripts/test_ttl_expiry_rules.ts"
