# Ensure we're in WSL and dependencies are installed inside WSL
# This guard prevents Windows-installed node_modules causing missing native/platform-specific packages
wsl bash -lc "
  set -e
  cd \"\$(wslpath -a '$PWD')\"
  if [ ! -d node_modules ] || [ ! -d node_modules/@solana-program/compute-budget ]; then
    echo '[WSL Guard] Installing dependencies in WSL...'
    rm -rf node_modules package-lock.json
    npm install
  fi
  npm run bot:run -- $args
"
