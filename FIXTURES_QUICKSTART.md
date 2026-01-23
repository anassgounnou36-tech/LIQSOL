# Kamino Lending Test Fixtures - Quick Start

## What Was Created

Two JSON test fixture files for Kamino Lending protocol accounts:

1. **test/fixtures/reserve_usdc.json** - USDC Reserve from Kamino Main Market
2. **test/fixtures/obligation_usdc_debt.json** - Obligation with SOL collateral and USDC debt

## Current Status

⚠️ **Action Required**: Fixtures need real on-chain data to be functional.

The `data_base64` fields currently contain `"TODO_FETCH_FROM_MAINNET"` placeholders because network access to Solana RPC was not available during creation.

## How to Populate Fixtures (Choose One)

### Option 1: Automated Script ⭐ Recommended

```bash
# Run with network access to Solana mainnet
node scripts/fetch_fixtures_from_mainnet.mjs
```

### Option 2: Manual JavaScript

```javascript
import { Connection, PublicKey } from '@solana/web3.js';
import { writeFileSync, readFileSync } from 'fs';

const connection = new Connection('https://api.mainnet-beta.solana.com');

// Fetch and update Reserve fixture
const reservePubkey = new PublicKey('d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q');
const reserveInfo = await connection.getAccountInfo(reservePubkey);
const reserveFixture = JSON.parse(readFileSync('test/fixtures/reserve_usdc.json'));
reserveFixture.data_base64 = reserveInfo.data.toString('base64');
reserveFixture.note = reserveFixture.note.replace(' - TEMPLATE FIXTURE', '');
delete reserveFixture._howToPopulate;
writeFileSync('test/fixtures/reserve_usdc.json', JSON.stringify(reserveFixture, null, 2));
console.log('✓ Updated reserve_usdc.json');
```

### Option 3: Using Solana CLI

```bash
# Fetch account data
solana account d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q --output json > reserve_data.json

# Then manually extract the base64 data and update the fixture
```

## Verification

Once populated, test the decoders:

```bash
npm test -- kamino-decoder
```

The decoders at `src/kamino/decode/` will use these fixtures.

## Documentation

- **test/fixtures/README.md** - Detailed fixture documentation
- **FIXTURE_CREATION_SUMMARY.md** - Technical implementation details
- **scripts/fetch_fixtures_from_mainnet.mjs** - Automated fetching script

## Questions?

See the README files for:
- Account structure details
- Alternative approaches
- Troubleshooting tips
- Integration examples
