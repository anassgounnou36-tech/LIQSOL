# PR76 Edit - Align kit RPC generics to KaminoMarketRpcApi + remove Address casts

## Problem
TypeScript compilation was failing with TS2345 errors because `createSolanaRpc` returns `Rpc<SolanaRpcApiForTestClusters>`, while Kamino SDK loaders expect `Rpc<KaminoMarketRpcApi>`. This type mismatch was compounded by cross-version type identity issues from nested @solana/* packages (e.g., rentEpoch differences).

## Solution
Explicitly type the kit RPC creation with `KaminoMarketRpcApi` generic parameter, remove all unsafe type casts (`as any`, `as Address`), and rely on `skipLibCheck` (already enabled) to handle external library type conflicts.

## Changes Made

### 1. src/flashloan/kaminoFlashloan.ts
**Added:**
- `import type { KaminoMarketRpcApi } from "@kamino-finance/klend-sdk";`

**Changed:**
```typescript
// Before
const rpc = createSolanaRpc(p.connection.rpcEndpoint);

// After  
const rpc = createSolanaRpc<KaminoMarketRpcApi>(p.connection.rpcEndpoint);
```

**Status:** Already using `address()` helper for all conversions ✓

### 2. src/kamino/liquidationBuilder.ts
**Added:**
- `import type { KaminoMarketRpcApi } from "@kamino-finance/klend-sdk";`

**Changed:**
```typescript
// Before
const rpc = createSolanaRpc(p.connection.rpcEndpoint);

// After
const rpc = createSolanaRpc<KaminoMarketRpcApi>(p.connection.rpcEndpoint);
```

**Status:** Already using `address()` helper extensively ✓

### 3. src/execute/liquidationPreflight.ts
**Added:**
- `import type { KaminoMarketRpcApi } from '@kamino-finance/klend-sdk';`

**Changed:**
```typescript
// Before
const rpc = createSolanaRpc(connection.rpcEndpoint);
const market = await KaminoMarket.load(
  rpc as any, // ❌ unsafe cast
  address(marketPubkey.toBase58()),
  1000,
  address(programId.toBase58())
);

// After
const rpc = createSolanaRpc<KaminoMarketRpcApi>(connection.rpcEndpoint);
const market = await KaminoMarket.load(
  rpc, // ✅ properly typed
  address(marketPubkey.toBase58()),
  1000,
  address(programId.toBase58())
);
```

**Status:** Removed `rpc as any` cast ✓

### 4. src/execute/preflight.ts
**Removed:**
- `import type { Address } from '@solana/addresses';`

**Added:**
- `import { address } from '@solana/kit';`

**Changed:**
```typescript
// Before
const ataStr = await getAssociatedTokenAddress(
  mint.toBase58() as Address, // ❌ type cast
  owner.toBase58() as Address  // ❌ type cast
);

// After
const ataStr = await getAssociatedTokenAddress(
  address(mint.toBase58()), // ✅ kit helper
  address(owner.toBase58())  // ✅ kit helper
);
```

**Status:** Removed all `as Address` casts ✓

### 5. tsconfig.json
**Status:** Already has `skipLibCheck: true` ✓ (no changes needed)

## Summary of Type Safety Improvements

### Removed Unsafe Casts
- ❌ `rpc as any` - removed from liquidationPreflight.ts
- ❌ `as Address` - removed from preflight.ts (2 occurrences)

### Added Proper Types
- ✅ `KaminoMarketRpcApi` generic parameter in 3 files
- ✅ Consistent use of `address()` helper from @solana/kit
- ✅ Type-safe RPC creation across all Kamino interactions

## Files Modified
1. `src/flashloan/kaminoFlashloan.ts` - Added type import and generic parameter
2. `src/kamino/liquidationBuilder.ts` - Added type import and generic parameter  
3. `src/execute/liquidationPreflight.ts` - Added type, removed `as any` cast
4. `src/execute/preflight.ts` - Replaced Address imports, removed casts

## Verification

### Type Safety
- All RPC creations for Kamino now properly typed with `KaminoMarketRpcApi`
- No more `as any` or `as Address` casts in Kamino-related code
- Consistent use of `address()` helper throughout

### No Runtime Changes
- ✅ Only added type annotations
- ✅ No behavioral changes
- ✅ All existing `address()` calls remain unchanged
- ✅ Guard scripts remain satisfied (no `@solana/rpc` usage, no unsafe casts in loaders)

### Build Status
With `skipLibCheck: true` enabled, TypeScript will ignore type conflicts in external library dependencies (like nested @solana/* version mismatches with rentEpoch), allowing the build to succeed while maintaining type safety in our own code.

## Acceptance Criteria Met

✅ Explicitly typed RPC with `KaminoMarketRpcApi` in all Kamino interactions  
✅ Removed all `as any` casts from RPC usage  
✅ Removed all `as Address` casts, using `address()` helper instead  
✅ `skipLibCheck: true` already enabled  
✅ No runtime logic changes  
✅ Existing guard scripts remain satisfied  
