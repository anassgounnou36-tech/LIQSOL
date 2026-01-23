# Kamino Lending Test Fixtures

This directory contains test fixtures for Kamino Lending protocol accounts.

## Status

⚠️ **Current fixtures are templates** - They require real on-chain data to be functional.

The `data_base64` fields currently contain placeholder values (`TODO_FETCH_FROM_MAINNET`) because:
1. Network access to Solana RPC is not available in the current environment
2. Manual Borsh encoding of complex Kamino account structures is error-prone

## Fixtures

### reserve_usdc.json
- **Account**: USDC Reserve from Kamino Main Market
- **Pubkey**: `d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q`
- **Expected Fields**:
  - Market: `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`
  - Liquidity Mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC)

### obligation_usdc_debt.json
- **Account**: Obligation with SOL collateral and USDC debt
- **Pubkey**: `H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo` (mock account for testing)
- **Expected Fields**:
  - Market: `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`

## How to Populate with Real Data

### Option 1: Use the provided script (recommended)

```bash
# Run with network access to Solana mainnet RPC
node scripts/fetch_fixtures_from_mainnet.mjs
```

This script will:
1. Fetch the real Reserve account data from Solana mainnet
2. Encode it to base64 and update `reserve_usdc.json`
3. Provide instructions for adding a real Obligation fixture

### Option 2: Manual fetch

```javascript
import { Connection, PublicKey } from '@solana/web3.js';

const connection = new Connection('https://api.mainnet-beta.solana.com');

// Fetch Reserve
const reserveInfo = await connection.getAccountInfo(
  new PublicKey('d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q')
);
console.log('Reserve data_base64:', reserveInfo.data.toString('base64'));

// Fetch Obligation (you need to find a real obligation address first)
const obligationInfo = await connection.getAccountInfo(
  new PublicKey('YOUR_REAL_OBLIGATION_PUBKEY')
);
console.log('Obligation data_base64:', obligationInfo.data.toString('base64'));
```

### Option 3: Use Kamino SDK

```javascript
import { KaminoMarket } from '@kamino-finance/klend-sdk';
import { Connection } from '@solana/web3.js';

const connection = new Connection('https://api.mainnet-beta.solana.com');
const market = await KaminoMarket.load(...);
// Use SDK methods to get account data
```

## Testing

Once the fixtures are populated with real data:

```bash
npm test -- kamino-decoder
```

The decoders in `src/kamino/decode/` will use these fixtures to test decoding functionality.

## Account Structure

### Reserve
- Contains lending pool configuration
- Tracks available liquidity and borrowed amounts
- Includes oracle configurations for price feeds
- Has LTV and liquidation threshold settings

### Obligation  
- Represents a user's borrows and collateral
- Contains arrays of deposits (collateral) and borrows (debt)
- Tracks health metrics for liquidation monitoring

## Notes

- All account data uses Borsh serialization with Anchor discriminators
- The IDL at `src/kamino/idl/klend.json` defines the exact structure
- Decoders in `src/kamino/decode/` handle deserialization
- Real on-chain data is required for integration testing
