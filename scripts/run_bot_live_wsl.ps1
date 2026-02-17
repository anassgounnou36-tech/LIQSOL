# LIQSOL - Bot Live Runner (WSL)
# Professional integrated live runner with candidate/queue refresh

Write-Host "╔════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  LIQSOL Bot - Professional Live Runner        ║" -ForegroundColor Cyan
Write-Host "║  WSL Wrapper Script                           ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════╝`n" -ForegroundColor Cyan

# Get the current Windows directory
$windowsDir = (Get-Location).Path

# Convert to WSL path format
$wslPath = $windowsDir -replace '\\', '/' -replace '^([A-Z]):', { '/mnt/' + $matches[1].ToLower() }

Write-Host "Windows Path: $windowsDir" -ForegroundColor Yellow
Write-Host "WSL Path:     $wslPath`n" -ForegroundColor Yellow

# Run the bot live command via WSL
Write-Host "Starting LIQSOL bot in live mode..." -ForegroundColor Green
Write-Host ""

wsl bash -c "cd '$wslPath' && npm run bot:live"

Write-Host "`nBot live runner exited." -ForegroundColor Yellow
