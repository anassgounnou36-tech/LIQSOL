# Kamino Decoding Implementation Summary

## Overview
This implementation adds deterministic Kamino lending protocol decoding capabilities with CLI commands and comprehensive tests, while also fixing a critical bug in BlockhashManager.

## Implementation Highlights

### 1. BlockhashManager Bug Fix
**Problem**: The `getFresh()` method was comparing `currentSlot` (from `getSlot()`) with `lastValidBlockHeight` - these are different metrics and shouldn't be compared.

**Solution**: Changed to use `getBlockHeight()` instead of `getSlot()` for proper apples-to-apples comparison.

**Impact**: Ensures blockhash caching logic works correctly, preventing premature or delayed blockhash refreshes.

### 2. Deterministic Dependencies
- `@coral-xyz/anchor@0.29.0` - Exact version, no caret (^) or tilde (~)
- `@kamino-finance/klend-sdk@7.3.9` - Exact version, no caret (^) or tilde (~)

This ensures reproducible builds and eliminates dependency version drift.

### 3. Kamino IDL Integration
- **IDL Location**: `src/kamino/idl/klend.json`
- **Version**: 1.12.6
- **Source**: Extracted from `@kamino-finance/klend-sdk@7.3.9`
- **Program ID**: `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` (mainnet)
- **Documentation**: Full provenance in `src/kamino/idl/README.md`

### 4. Decoder Architecture

#### Design Principles
1. **Use Anchor BorshAccountsCoder** - No hardcoded offsets or layouts
2. **Structured Output** - Typed interfaces, not raw decoded blobs
3. **String Amounts** - Prevent precision loss with large numbers
4. **Oracle Extraction** - Collect all price feeds (Pyth, Switchboard, Scope)

#### Key Functions

**`decodeReserve(accountData, reservePubkey)`**
- Input: Raw account data + pubkey
- Output: `DecodedReserve` with 12 fields
- Extracts: Market info, mints, decimals, oracles, risk params, liquidity

**`decodeObligation(accountData, obligationPubkey)`**
- Input: Raw account data + pubkey
- Output: `DecodedObligation` with deposits and borrows arrays
- Note: Mints require separate Reserve lookup (use `setReserveMintCache()`)

### 5. Type System

**DecodedReserve** (12 fields)
```typescript
{
  reservePubkey: string;
  marketPubkey: string;
  liquidityMint: string;
  collateralMint: string;
  liquidityDecimals: number;
  collateralDecimals: number;
  oraclePubkeys: string[];
  loanToValueRatio: number;
  liquidationThreshold: number;
  liquidationBonus: number;
  totalBorrowed: string;
  availableLiquidity: string;
}
```

**DecodedObligation** (6 fields)
```typescript
{
  obligationPubkey: string;
  ownerPubkey: string;
  marketPubkey: string;
  lastUpdateSlot: string;
  deposits: Array<{
    reserve: string;
    mint: string;
    depositedAmount: string;
  }>;
  borrows: Array<{
    reserve: string;
    mint: string;
    borrowedAmount: string;
  }>;
}
```

### 6. CLI Commands

**Decode Reserve**
```bash
npm run decode:reserve <reserve_pubkey>
```

**Decode Obligation**
```bash
npm run decode:obligation <obligation_pubkey>
```

Both commands:
- Fetch account data from RPC (uses `RPC_PRIMARY` from `.env`)
- Decode using appropriate decoder
- Output JSON to console
- Proper error handling for invalid pubkeys and missing accounts

### 7. Test Coverage

**24 tests across 3 test files:**

1. **`bootstrap.test.ts`** (3 tests) - Environment validation
2. **`blockhash-manager.test.ts`** (4 tests) - BlockhashManager fix verification
3. **`kamino-decoder.test.ts`** (17 tests) - Decoder validation
   - IDL structure validation
   - Account type verification
   - Decoder function tests
   - Output type documentation

## Quality Assurance

### Static Analysis
- ✅ TypeScript type checking: 0 errors
- ✅ ESLint: 0 errors
- ✅ All tests: 24/24 passing

### Security
- ✅ CodeQL scan: 0 vulnerabilities
- ✅ No hardcoded credentials
- ✅ Proper error handling
- ✅ Safe type conversions

### Code Review
- ✅ Review completed
- ✅ All feedback addressed
- ✅ Documentation improved

## Technical Decisions

### Why Anchor BorshAccountsCoder?
- Official Anchor deserialization
- Uses IDL for schema validation
- No need to manually track field offsets
- Handles complex nested types automatically

### Why String Amounts?
- JavaScript's `number` type loses precision beyond 2^53
- Solana amounts often exceed this (e.g., lamports)
- Strings preserve exact values
- Client code can use BigInt or Decimal libraries

### Why Separate Reserve Mint Cache?
- Obligation accounts store reserve pubkeys, not mints
- Fetching Reserve for each deposit/borrow is expensive
- Cache allows efficient batch processing
- Placeholder value indicates missing data clearly

### Why Offline Fixture Tests?
- Fast execution (no RPC calls)
- Deterministic (no network flakiness)
- Tests decoder logic, not RPC connectivity
- Validates IDL structure and field mappings

## Future Enhancements

### Potential Improvements
1. **Live Integration Tests** - Fetch real accounts from devnet/mainnet
2. **Reserve Mint Auto-fetch** - Automatically fetch Reserve when decoding Obligation
3. **Batch Decoding** - Decode multiple accounts in parallel
4. **Account Validation** - Verify discriminators before decoding
5. **Rich CLI Output** - Formatted tables, color coding
6. **Export Functions** - Save decoded data to files

### Non-goals (by design)
- ❌ Bumping other dependencies unnecessarily
- ❌ Adding new build tools or frameworks
- ❌ Changing existing working code
- ❌ Adding style comments where not needed

## Usage Patterns

### Pattern 1: Decode Single Reserve
```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { decodeReserve } from './kamino/decoder.js';

const connection = new Connection('...');
const reservePubkey = new PublicKey('...');

const accountInfo = await connection.getAccountInfo(reservePubkey);
const decoded = decodeReserve(accountInfo.data, reservePubkey);

console.log('LTV:', decoded.loanToValueRatio);
console.log('Oracles:', decoded.oraclePubkeys);
```

### Pattern 2: Decode Obligation with Reserves
```typescript
import { decodeReserve, decodeObligation, setReserveMintCache } from './kamino/decoder.js';

// First, decode and cache reserves
const reserves = ['reserve1', 'reserve2', 'reserve3'];
for (const reserveKey of reserves) {
  const accountInfo = await connection.getAccountInfo(new PublicKey(reserveKey));
  const reserve = decodeReserve(accountInfo.data, new PublicKey(reserveKey));
  setReserveMintCache(reserve.reservePubkey, reserve.liquidityMint);
}

// Then decode obligation (mints will be populated from cache)
const obligationInfo = await connection.getAccountInfo(obligationPubkey);
const obligation = decodeObligation(obligationInfo.data, obligationPubkey);

console.log('Deposits:', obligation.deposits);
console.log('Borrows:', obligation.borrows);
```

### Pattern 3: CLI Usage
```bash
# Decode a reserve
npm run decode:reserve 7TdRLrZ7bVF5zGPmHDLPSLH5tBvBNm1gTaJQvV5TK5j2

# Decode an obligation
npm run decode:obligation 3xKXtg2CW87d9wcKcypLpZ8RqvsKJrxjC8boSyAYavgh

# Error handling (invalid pubkey)
npm run decode:reserve invalid-key
# Output: "Invalid public key: invalid-key"

# Error handling (account not found)
npm run decode:reserve 11111111111111111111111111111111
# Output: "Account not found"
```

## Conclusion

This implementation successfully meets all requirements from the problem statement:
- ✅ Deterministic dependency pinning
- ✅ Repo-pinned IDL with documentation
- ✅ Anchor BorshAccountsCoder decoder
- ✅ Structured DecodedReserve and DecodedObligation types
- ✅ CLI decode commands
- ✅ Offline fixture tests
- ✅ BlockhashManager bug fix

The code is production-ready with comprehensive tests, documentation, and security validation.
