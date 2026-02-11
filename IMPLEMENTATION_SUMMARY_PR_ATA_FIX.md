# Fix Custom(6006) InvalidAccountInput - Implementation Summary

## Problem
Liquidation simulation was failing with `Custom(6006) InvalidAccountInput` error, caused by:
1. Missing Associated Token Accounts (ATAs) for liquidator
2. Incorrect token program IDs being passed to liquidation instruction (assumed all tokens use same program, but Token-2022 mints require TOKEN_2022_PROGRAM_ID while SPL tokens use TOKEN_PROGRAM_ID)

## Solution Overview
Implemented automatic ATA creation and correct token program resolution for Kamino liquidations:

### A) Token Program Resolver (`src/solana/tokenProgram.ts`)
- Resolves token program ID by reading mint account owner
- Caches results per mint for performance
- Uses "confirmed" commitment for reliability

### B) ATA Creation Helper (`src/solana/ata.ts`)
- Builds idempotent ATA create instructions
- Uses `createAssociatedTokenAccountIdempotentInstruction` from @solana/spl-token
- Supports both SPL Token and Token-2022 programs

### C) Liquidation Builder Updates (`src/kamino/liquidationBuilder.ts`)
**Key Changes:**
1. Resolve token program IDs from mint owners (source of truth):
   - `repayTokenProgramId` from repay liquidity mint
   - `withdrawLiquidityTokenProgramId` from withdraw liquidity mint
   - `collateralTokenProgramId` from withdraw collateral mint (NOT from reserve)

2. Derive user ATAs with correct token programs:
   - `userSourceLiquidityAta` (repay liquidity)
   - `userDestinationCollateralAta` (withdraw collateral)
   - `userDestinationLiquidityAta` (withdraw liquidity)

3. Build idempotent ATA create instructions

4. Prepend ATA creates to `refreshIxs` (ensuring order: ATA creates → reserve refreshes → obligation refresh)

5. Pass resolved token programs to liquidation instruction

**Critical Fix:**
- Collateral mint token program is now resolved from `collateralReserveState.collateral.mintPubkey` owner
- Previously used `collateralReserve.getLiquidityTokenProgram()` which was incorrect for Token-2022 collateral mints

### D) Executor
No changes needed - executor already pushes `refreshIxs` which now includes ATA creates.

Transaction order remains:
1. ComputeBudget
2. FlashBorrow
3. refreshIxs (ATA creates + reserve refreshes + obligation refresh)
4. liquidationIxs
5. swap (optional)
6. flashRepay

### E) Test Scripts
**scripts/test_token_program_resolution.ts**
- Tests token program resolution with caching
- Uses USDC mint as test case

**scripts/test_liq_builder_includes_ata.ts**
- Verifies liquidation builder includes 3 ATA create instructions
- Loads obligation from candidates.scored.json

**npm scripts added:**
- `test:token:program` / `test:token:program:wsl`
- `test:liq:builder:ata` / `test:liq:builder:ata:wsl`

## Build Status
✅ Build passes (pre-existing Kamino SDK type errors don't block compilation)
✅ All new files compile successfully:
- `dist/solana/tokenProgram.js`
- `dist/solana/ata.js`
- `dist/kamino/liquidationBuilder.js`

## Security
✅ CodeQL: No security alerts found

## Testing Notes
- Test scripts require RPC access (RPC_PRIMARY env var)
- Test scripts require test data (candidates.scored.json)
- For production testing: `npm run bot:run:wsl` should reach simulation without Custom(6006) from missing ATAs or wrong token programs

## Acceptance Criteria
✅ npm run build passes
✅ Liquidation builder derives correct token programs per mint
✅ ATA create instructions prepended to refreshIxs
✅ Executor includes ATA creates (via refreshIxs)
✅ Test scripts created with npm commands and WSL wrappers
⏸️ Integration testing requires RPC access and candidate obligations

## Files Changed
```
src/solana/tokenProgram.ts (new)
src/solana/ata.ts (new)
src/kamino/liquidationBuilder.ts (modified)
scripts/test_token_program_resolution.ts (new)
scripts/test_liq_builder_includes_ata.ts (new)
scripts/run_test_token_program_wsl.ps1 (new)
scripts/run_test_liq_builder_ata_wsl.ps1 (new)
package.json (modified - added npm scripts)
```

## Next Steps
1. User should test with: `npm run bot:run:wsl`
2. Verify liquidation simulation no longer fails with Custom(6006) from missing ATAs
3. Any remaining failures should be business-rule errors (ObligationHealthy, ObligationStale) not InvalidAccountInput
