# Reserve and Oracle Caching System

This directory contains the caching infrastructure for Kamino Lending V2 reserves and oracle data, enabling fast and accurate market state access for liquidation scoring.

## Overview

The caching system provides:
- **Reserve Cache**: Efficient loading and storage of all reserves in a Kamino market
- **Oracle Cache**: Fetching and decoding of Pyth and Switchboard oracle price data
- **Unified API**: Single entry point for loading both caches at bot startup

## Architecture

### Reserve Cache (`reserveCache.ts`)

Loads all reserves for a given Kamino market using an efficient two-phase approach:

1. **Phase 1 - Pubkey Discovery**: Uses `getProgramAccounts` with discriminator filter and `dataSlice` to fetch only reserve pubkeys
2. **Phase 2 - Batch Fetching**: Uses `getMultipleAccountsInfo` in batches of 100 to fetch full account data

Key features:
- Filters reserves by market pubkey after decoding
- Stores data keyed by liquidity mint for fast lookup
- Automatically populates `setReserveMintCache` for obligation decoding
- Comprehensive error handling and logging

### Oracle Cache (`oracleCache.ts`)

Loads oracle price data for all oracles referenced in the reserve cache:

1. Collects unique oracle pubkeys from all reserves
2. Batch fetches oracle account data
3. Decodes Pyth and Switchboard oracle accounts
4. Maps oracle data to mints

Supports:
- **Pyth V2**: Full price, confidence, slot, and exponent decoding
- **Switchboard V2**: Mantissa, scale, standard deviation decoding
- **Auto-detection**: Automatically determines oracle type from account structure

### Integration Entry Point (`index.ts`)

Provides a single function `loadMarketCaches()` that:
1. Loads reserves first
2. Uses reserve cache to load oracles
3. Returns both caches together
4. Logs timing and summary statistics

## Usage

### Basic Usage

```typescript
import { Connection, PublicKey } from "@solana/web3.js";
import { loadMarketCaches } from "./cache/index.js";

const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const marketPubkey = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");

const { reserves, oracles } = await loadMarketCaches(connection, marketPubkey);

// Access reserve by mint
const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const usdcReserve = reserves.get(usdcMint);
if (usdcReserve) {
  console.log(`USDC LTV: ${usdcReserve.loanToValue}%`);
}

// Access oracle by mint
const usdcOracle = oracles.get(usdcMint);
if (usdcOracle) {
  console.log(`USDC price: ${usdcOracle.price} (exponent: ${usdcOracle.exponent})`);
}
```

### Loading Reserves Only

```typescript
import { loadReserves } from "./cache/reserveCache.js";

const reserves = await loadReserves(connection, marketPubkey);
for (const [mint, reserve] of reserves) {
  console.log(`${mint}: ${reserve.availableAmount} available`);
}
```

### Loading Oracles Only

```typescript
import { loadOracles } from "./cache/oracleCache.js";

// Requires reserve cache to know which oracles to fetch
const oracles = await loadOracles(connection, reserves);
for (const [mint, oracle] of oracles) {
  console.log(`${mint}: ${oracle.oracleType} - ${oracle.price}`);
}
```

## CLI Tool

Verify reserve decoding with the CLI tool:

```bash
npm run verify:reserves
```

This will:
1. Load all reserves for the market specified in `KAMINO_MARKET_PUBKEY`
2. Display reserve details including mints, LTV, liquidation thresholds, and oracles
3. Validate the decoding process end-to-end

## Data Structures

### ReserveCacheEntry

```typescript
interface ReserveCacheEntry {
  reservePubkey: PublicKey;
  availableAmount: bigint;
  cumulativeBorrowRate?: bigint;  // Optional - not yet extracted from IDL
  loanToValue: number;
  liquidationThreshold: number;
  liquidationBonus: number;
  oraclePubkeys: PublicKey[];
}
```

### OraclePriceData

```typescript
interface OraclePriceData {
  price: bigint;
  confidence: bigint;
  slot: bigint;
  exponent: number;
  oracleType: "pyth" | "switchboard";
}
```

## Performance

Typical performance for Kamino Main Market (~30 reserves):
- Reserve loading: ~5-10 seconds (depending on RPC)
- Oracle loading: ~2-5 seconds
- Total: ~7-15 seconds for full cache initialization

Batching ensures efficient RPC usage:
- Max 1 `getProgramAccounts` call
- Max N/100 `getMultipleAccountsInfo` calls (where N = number of reserves)

## Testing

Comprehensive test suite covering:
- Reserve cache loading and filtering
- Oracle cache with Pyth and Switchboard
- Error handling (null data, decode errors)
- Batching logic
- Integration between reserve and oracle caches

Run tests:
```bash
npm test src/__tests__/reserveCache.test.ts
npm test src/__tests__/oracleCache.test.ts
npm test src/__tests__/cacheIndex.test.ts
```

## Error Handling

The caching system is designed to be resilient:
- Skips reserves/oracles with missing account data
- Logs decode errors but continues processing
- Validates minimum expected reserves (warns if < 5)
- Returns empty cache rather than throwing on errors

## Integration with Obligation Decoding

The reserve cache automatically calls `setReserveMintCache()` for each reserve, which enables the obligation decoder to populate mint fields without additional RPC calls.

This is critical because obligation accounts store reserve pubkeys but not mints, and the caching system ensures this mapping is always available.

## Future Enhancements

Potential improvements for later PRs:
- Cache refresh/invalidation strategies
- Scope oracle support (currently Pyth and Switchboard only)
- WebSocket-based oracle updates for real-time prices
- Persistent cache storage (Redis/file-based)
- Cumulative borrow rate extraction from IDL (currently placeholder)
