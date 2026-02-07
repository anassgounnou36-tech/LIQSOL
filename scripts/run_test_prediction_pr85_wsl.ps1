param([string]$Top = "10")
# Ensure node tooling runs in WSL; allow future args passthrough if needed
wsl tsx scripts/test_prediction_pr85.ts
