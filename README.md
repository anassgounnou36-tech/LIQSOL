# LIQSOL - TypeScript Solana Bot

A TypeScript-based Solana bot with structured logging, environment validation, and boot checks.

## Features

- ✅ TypeScript with ESM and strict mode
- ✅ Environment validation using Zod (fails fast if invalid)
- ✅ Structured logging with Pino (pretty output in development)
- ✅ Boot checks: RPC latency, current slot, bot public key
- ✅ GitHub Actions CI pipeline

## Prerequisites

- Node.js >= 18.0.0
- npm or yarn

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file (see `.env.example`):
   ```bash
   cp .env.example .env
   ```

3. Generate a Solana keypair:
   ```bash
   solana-keygen new -o keypair.json --no-bip39-passphrase
   ```
   Or use Node.js:
   ```bash
   node -e "const {Keypair} = require('@solana/web3.js'); const fs = require('fs'); fs.writeFileSync('keypair.json', JSON.stringify(Array.from(Keypair.generate().secretKey)));"
   ```

4. Update `.env` with your keypair path and RPC URL:
   ```
   BOT_KEYPAIR_PATH=./keypair.json
   RPC_URL=https://api.devnet.solana.com
   NODE_ENV=development
   ```

## Development

```bash
# Run in development mode
npm run dev

# Build
npm run build

# Run built version
npm start

# Type check
npm run typecheck

# Lint
npm run lint

# Test
npm run test
npm run test:watch
```

## Project Structure

```
.
├── src/
│   ├── config/
│   │   └── env.ts           # Environment validation with Zod
│   ├── observability/
│   │   └── logger.ts        # Pino logger setup
│   ├── __tests__/
│   │   └── bootstrap.test.ts
│   └── index.ts             # Main entry point with boot checks
├── .github/
│   └── workflows/
│       └── ci.yml           # GitHub Actions CI
├── package.json
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
└── .env.example
```

## Boot Process

When the bot starts, it performs the following checks:

1. **Environment Validation**: Validates all required environment variables
   - Verifies `BOT_KEYPAIR_PATH` file exists
   - Validates `RPC_URL` is a valid URL
   
2. **Keypair Loading**: Loads the bot's Solana keypair from the specified path

3. **RPC Connection Check**: 
   - Connects to the Solana RPC endpoint
   - Measures RPC latency
   - Fetches current slot
   
4. **Boot Success Log**: Outputs a structured `boot_ok` event with:
   - RPC URL
   - RPC latency (ms)
   - Current slot
   - Bot public key
   - Node environment

If any step fails, the bot logs a `boot_failed` event at fatal level and exits with code 1.

## Known Issues

### Windows: Native Binding Errors

On Windows, you may encounter errors when running `npm run snapshot:obligations` related to missing native bindings:

```
Cannot find native binding for yellowstone-grpc-napi-win32-x64-msvc
```

This occurs because the `@triton-one/yellowstone-grpc` package requires native Node.js bindings that may not be properly installed on Windows.

#### Solutions:

1. **Clean Reinstall** (try this first):
   
   **PowerShell:**
   ```powershell
   Remove-Item -Recurse -Force node_modules, package-lock.json
   npm install
   ```
   
   **Command Prompt:**
   ```cmd
   rmdir /s /q node_modules
   del package-lock.json
   npm install
   ```

2. **Use WSL2** (if clean reinstall fails):
   ```bash
   npm run snapshot:obligations:wsl
   ```
   
   This script automatically runs the snapshot command inside WSL2, which provides a Linux environment.
   
   **Prerequisites**: WSL2 must be installed. If not installed, run:
   ```bash
   wsl --install
   ```

#### Note
Production deployments should target Linux environments where native bindings are fully supported.

## CI/CD

The GitHub Actions workflow runs on every push and pull request:

1. Sets up Node.js (tests on 18.x and 20.x)
2. Installs dependencies with `npm ci`
3. Runs type checking (`npm run typecheck`)
4. Runs linting (`npm run lint`)
5. Runs tests (`npm run test`)

## License

MIT