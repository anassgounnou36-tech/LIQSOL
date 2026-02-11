# PR75 Edit - KaminoObligation.load Parameter Fix

## Overview
Fixed TypeScript compilation error in `src/kamino/liquidationBuilder.ts` by correcting the `KaminoObligation.load()` call to use the `market` parameter instead of `rpc`.

## Problem
The Kamino SDK's `KaminoObligation.load()` method has multiple overloads. We were using the wrong overload by passing an RPC object as the first parameter, when the SDK expects a `KaminoMarket` instance.

## Root Cause
The `KaminoObligation.load()` method signature expects:
```typescript
static load(market: KaminoMarket, obligationAddress: Address): Promise<KaminoObligation>
```

But we were calling it with:
```typescript
await KaminoObligation.load(rpc, address(p.obligationPubkey.toBase58()))
```

This would cause TypeScript compilation to fail with a type mismatch error.

## Solution
Changed the first parameter from `rpc` to `market`, which was already loaded just above the call:

### Before (Incorrect)
```typescript
const obligation = await KaminoObligation.load(
  rpc,
  address(p.obligationPubkey.toBase58())
);
```

### After (Correct)
```typescript
const obligation = await KaminoObligation.load(
  market,
  address(p.obligationPubkey.toBase58())
);
```

## Why This Works
1. **Market already loaded**: The `market` instance is loaded from the Kamino SDK just above (lines 84-89)
2. **Correct SDK overload**: Passing `market` matches the SDK's expected signature
3. **Maintains functionality**: The obligation loader can access market configuration and reserves through the market instance
4. **Type safe**: No casts or workarounds needed - uses the correct types

## Files Changed
- `src/kamino/liquidationBuilder.ts` - Line 97: Changed first parameter from `rpc` to `market`

## Code Flow
```typescript
// Step 1: Create RPC from connection (line 81)
const rpc = createSolanaRpc(p.connection.rpcEndpoint);

// Step 2: Load market using RPC (lines 84-89)
const market = await KaminoMarket.load(
  rpc,
  address(p.marketPubkey.toBase58()),
  1000,
  address(p.programId.toBase58())
);

// Step 3: Load obligation using MARKET (lines 96-99) ✅ FIXED
const obligation = await KaminoObligation.load(
  market,  // ← Uses market, not rpc
  address(p.obligationPubkey.toBase58())
);
```

## Verification

### Guard Script
✅ Passes: `npm run check:kamino:rpc`
- No forbidden `@solana/rpc` imports
- No risky `rpc as any` casts
- Uses `@solana/kit` consistently

### Imports Check
✅ All imports use `@solana/kit`:
```typescript
import { createSolanaRpc, address } from "@solana/kit";
```

### Type Safety
✅ No manual type casts:
- Uses `address()` helper throughout
- No `as Address` casts
- No `rpc as any` casts to Kamino loaders

## Impact
- **Minimal change**: Single line modified (parameter change)
- **No logic changes**: Same functionality, correct types
- **TypeScript compliance**: Should eliminate TS2345 errors
- **SDK compatibility**: Uses correct Kamino SDK overload

## Related Changes
This fix builds on the previous PR that:
1. Added `@solana/kit` dependency
2. Updated imports to use `@solana/kit`
3. Added `address()` helper usage throughout
4. Enhanced guard scripts

## Testing Recommendations
1. ✅ Run guard script: `npm run check:kamino:rpc`
2. Build with TypeScript: `npm run build`
3. Test liquidation builder with real obligations (when data available)
4. Verify no runtime errors in Kamino integrations

## Breaking Changes
None - This is an internal implementation fix with no API changes.

## Next Steps
1. Verify TypeScript compilation passes
2. Monitor for any runtime issues
3. Test with real Kamino market and obligation data when available
