# Kamino Lending Protocol Test Fixtures

This document describes the test fixtures created for the Kamino Lending protocol decoders.

## Files Created

### 1. test/fixtures/reserve_usdc.json
A mock USDC Reserve account from Kamino Main Market.

**Fields:**
- `pubkey`: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q" (USDC reserve address)
- `note`: Description of the fixture
- `data_base64`: Base64-encoded account data
- `expected.market`: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF" (Kamino Main Market)
- `expected.liquidityMint`: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" (USDC mint)

**Data Format:**
- Base64-encoded Borsh serialization of a Reserve account
- Size: 1502 bytes
- Includes correct Anchor discriminator for Reserve account

### 2. test/fixtures/obligation_usdc_debt.json  
A mock Obligation account with SOL collateral and USDC debt.

**Fields:**
- `pubkey`: "H6ARHf6YXhGU3NaCZRwojWAcV8KftzSmtqMLphnnaiGo"
- `note`: Description of the fixture
- `data_base64`: Base64-encoded account data  
- `expected.market`: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"

**Data Format:**
- Base64-encoded Borsh serialization of an Obligation account
- Size: 280 bytes
- Includes correct Anchor discriminator for Obligation account
- Contains 1 deposit (SOL collateral at "4UpD2fh7xH3GVMoZmZ3jb3XgDSVvWAYBP5c8DOffcKEV")
- Contains 1 borrow (USDC debt from "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q")

## Decoders Fixed

The following bugs were fixed in the decoders to properly use the BorshAccountsCoder:

### src/kamino/decode/reserveDecoder.ts
- **Line 100**: Changed `accountsCoder.decode("reserve", ...)` to `accountsCoder.decode("Reserve", ...)`
- The BorshAccountsCoder requires account names to match the case in the IDL exactly

### src/kamino/decode/obligationDecoder.ts
- **Line 88**: Changed `accountsCoder.decode("obligation", ...)` to `accountsCoder.decode("Obligation", ...)`
- Same reason as above

## Current Status

The fixtures have been created with:
✓ Correct Solana public keys
✓ Correct Anchor account discriminators
✓ Correct general Borsh encoding structure
✓ Expected values matching the test requirements

However, the fixtures are **not yet fully valid** for decoding because:
- The Reserve account has a complex structure with many nested fields
- Manual Borsh encoding is error-prone for such complex structures
- The fixtures may need actual Borsh-encoded data to fully validate

## How to Complete the Fixtures

To populate these fixtures with fully valid data, you have two options:

### Option 1: Fetch from Real Blockchain (Recommended)
1. Set up network access to Solana mainnet
2. Run: `tsx scripts/fetch_fixture.ts <reserve_pubkey> reserve_usdc 7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF`
3. Repeat for obligation accounts

### Option 2: Use Kamino SDK
The @kamino-finance/klend-sdk provides proper encoding/decoding utilities. You can:
1. Create accounts using the SDK's proper types
2. Encode them using the SDK's BorshAccountsCoder
3. Save the encoded data to fixtures

### Option 3: Use Real Account Data
If you have RPC access, use the scripts/fetch_fixture.ts script that's already set up to fetch real account data from the chain.

## Testing

To verify the fixtures work:
```bash
npm test
```

The tests will verify that the decoders can handle the discriminator and basic structure validation.

## Related Files

- `src/kamino/decode/reserveDecoder.ts` - Reserve decoding logic
- `src/kamino/decode/obligationDecoder.ts` - Obligation decoding logic
- `src/kamino/idl/klend.json` - Kamino Lending IDL (Account definitions)
- `src/kamino/types.ts` - TypeScript interfaces for decoded data
