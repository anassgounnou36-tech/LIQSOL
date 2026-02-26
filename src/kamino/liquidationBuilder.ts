import { Connection, PublicKey, TransactionInstruction, AddressLookupTableAccount, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { KaminoMarket, KaminoObligation, refreshReserve, refreshObligation, liquidateObligationAndRedeemReserveCollateral, refreshObligationFarmsForReserve, obligationFarmStatePda } from "@kamino-finance/klend-sdk";
import { createSolanaRpc, address } from "@solana/kit";
import { AccountRole } from "@solana/instructions";
import { none, some } from "@solana/options";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Buffer } from "node:buffer";
import BN from "bn.js";
import { parseUiAmountToBaseUnits } from "../execute/amount.js";
import { resolveTokenProgramId } from "../solana/tokenProgram.js";
import { buildCreateAtaIdempotentIx } from "../solana/ata.js";
import { addressSafe } from "../solana/addressSafe.js";
import { toBigInt, gtZero } from "../utils/bn.js";
import { SYSVAR_RENT_ADDRESS } from "@solana/sysvars";
import { KLEND_PROGRAM_ID as KLEND_PROGRAM_ID_FROM_DECODER, KAMINO_DISCRIMINATORS } from "../execute/decodeKaminoKindFromCompiled.js";

// Kamino Farms program ID (mainnet)
const FARMS_PROGRAM_ID = "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr";
// System program ID (well-known constant)
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const DEFAULT_PRE_RESERVE_FULL_REFRESH_MAX_RESERVES = 6;

// Re-export KLEND program ID for convenience
export const KLEND_PROGRAM_ID = KLEND_PROGRAM_ID_FROM_DECODER;

// Re-export liquidation v1 discriminator for executor validation
export const LIQUIDATE_V1_DISCRIMINATOR = KAMINO_DISCRIMINATORS.liquidateObligationAndRedeemReserveCollateral;

/**
 * PR62: Parameters for building Kamino liquidation instructions.
 * Now derives reserves from obligation (no collateralMint/repayMint required in params)
 * 
 * PR: Added strict preflight validation with expected reserve pubkeys
 */
export interface BuildKaminoLiquidationParams {
  connection: Connection;
  marketPubkey: PublicKey;
  programId: PublicKey;
  
  // Obligation to liquidate
  obligationPubkey: PublicKey;
  
  // Liquidator public key (not Keypair - more flexible)
  liquidatorPubkey: PublicKey;
  
  // Optional preference for repay mint (defaults to USDC strategy if not provided)
  repayMintPreference?: PublicKey;
  
  // Optional: repay amount in UI units (will be converted to base units)
  // If not provided, derives from borrow amount with protocol-safe clamping
  repayAmountUi?: string;
  
  // PR: Expected reserve pubkeys for preflight validation (from plan)
  // If provided, will validate that selected reserves match these pubkeys
  expectedRepayReservePubkey?: PublicKey;
  expectedCollateralReservePubkey?: PublicKey;
  preReserveRefreshMode?: 'all' | 'primary' | 'auto';
  disableFarmsRefresh?: boolean;
}

/**
 * PR62: Result containing refresh and liquidation instructions
 * Now includes derived repayMint and collateralMint for downstream validation
 * 
 * TX Size Fix: Added setupIxs for out-of-band ATA creation
 * 
 * ReserveStale Fix: Added preRefreshIxs for slot freshness before RefreshObligation
 * 
 * KLend Adjacency Fix: Restructured to match strict check_refresh validation:
 * - preReserveIxs: RefreshReserve for selected obligation reserves (deposits→borrows)
 * - coreIxs: RefreshObligation + RefreshFarms (collateral and/or debt, 0-2 instructions)
 * - liquidationIxs: LiquidateObligationAndRedeemReserveCollateral
 * - postFarmIxs: Same RefreshFarms as coreIxs (mirrors PRE farms for adjacency)
 * - Removed postRefreshIxs (reserve refreshes) entirely - they break adjacency
 */
export interface KaminoLiquidationResult {
  setupIxs: TransactionInstruction[]; // ATA create instructions (only for missing ATAs)
  setupAtaNames: string[]; // Names of ATAs in setupIxs for labeling (e.g., ['repay', 'collateral'])
  missingAtas: Array<{ mint: string; ataAddress: string; purpose: 'repay' | 'collateral' | 'withdrawLiq' }>;
  preReserveIxs: TransactionInstruction[]; // PRE: RefreshReserve for selected obligation reserves (deposits→borrows)
  coreIxs: TransactionInstruction[]; // CORE: RefreshObligation + RefreshFarms (0-2 farm instructions)
  liquidationIxs: TransactionInstruction[]; // LIQUIDATE: LiquidateObligationAndRedeemReserveCollateral
  postFarmIxs: TransactionInstruction[]; // POST: RefreshFarms (mirrors coreIxs farms, immediately after liquidation)
  lookupTables?: AddressLookupTableAccount[];
  repayMint: PublicKey;
  collateralMint: PublicKey; // Liquidity mint of collateral reserve
  withdrawCollateralMint: PublicKey; // Actual collateral mint used for redemption (user_destination_collateral)
  // Metadata for instruction labeling
  ataCount: number; // Number of ATA create instructions in setupIxs
  farmRefreshCount: number; // Number of farm refresh instructions in coreIxs (0-2)
  farmRequiredModes: number[]; // Farm modes required by reserve state: 0=collateral, 1=debt
  farmModes: number[]; // Farm modes included: 0=collateral, 1=debt (for labeling)
}

/**
 * Type for SDK instruction account structure
 */
interface SdkAccount {
  address: unknown;
  role: AccountRole;
  name?: string;
}

/**
 * Convert SDK instruction account to web3.js AccountMeta using AccountRole enum
 * Uses addressSafe to provide context on invalid addresses
 */
function convertSdkAccount(a: SdkAccount, ctx: string = 'sdkAccount') {
  const role = a.role as AccountRole;
  const accountName = a.name ?? 'unknown';
  const addr = addressSafe(a.address, `${ctx}:${accountName}`);
  
  return {
    pubkey: new PublicKey(addr),
    isSigner: role === AccountRole.READONLY_SIGNER || role === AccountRole.WRITABLE_SIGNER,
    isWritable: role === AccountRole.WRITABLE || role === AccountRole.WRITABLE_SIGNER,
  };
}

function parsePublicKeyish(v: unknown): PublicKey | null {
  if (!v) return null;

  if (v instanceof PublicKey) return v;

  const maybeToBase58 = (v as { toBase58?: unknown })?.toBase58;
  if (typeof maybeToBase58 === 'function') {
    try { return new PublicKey((maybeToBase58 as () => string).call(v)); } catch {}
  }

  if (v instanceof Uint8Array && v.length === 32) return new PublicKey(v);
  if (Buffer.isBuffer(v) && v.length === 32) return new PublicKey(v);
  if (Array.isArray(v) && v.length === 32 && v.every(x => typeof x === 'number')) {
    return new PublicKey(Uint8Array.from(v));
  }

  const inner = (v as { data?: unknown; bytes?: unknown; value?: unknown })?.data
    ?? (v as { data?: unknown; bytes?: unknown; value?: unknown })?.bytes
    ?? (v as { data?: unknown; bytes?: unknown; value?: unknown })?.value;
  if (inner instanceof Uint8Array && inner.length === 32) return new PublicKey(inner);
  if (Buffer.isBuffer(inner) && inner.length === 32) return new PublicKey(inner);
  if (Array.isArray(inner) && inner.length === 32 && inner.every((x: unknown) => typeof x === 'number')) {
    return new PublicKey(Uint8Array.from(inner));
  }

  if (typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) {
    try { return new PublicKey(v); } catch {}
  }

  const s = (v as { toString?: () => string })?.toString?.();
  if (typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) {
    try { return new PublicKey(s); } catch {}
  }

  return null;
}

/**
 * PR62: Build REAL Kamino liquidation instructions using SDK.
 * 
 * Major changes in PR62:
 * - Derives repay and collateral reserves from obligation (no longer requires them as params)
 * - Returns repayMint and collateralMint in result for downstream validation
 * - Derives repay amount from borrow if not provided (with protocol-safe clamping)
 * - Fail-fast on missing data (no magic defaults)
 * 
 * This implementation:
 * 1) Loads market + reserves + obligation from chain
 * 2) Selects repay reserve from obligation borrows (preference or highest USD)
 * 3) Selects collateral reserve from obligation deposits (highest USD or first non-zero)
 * 4) Builds refresh instructions (2 reserves + obligation)
 * 5) Derives/converts repay amount with exact string→integer conversion (no float math)
 * 6) Builds liquidation instruction with all derived accounts
 * 7) Returns refreshIxs + liquidationIxs + repayMint + collateralMint
 * 
 * @param p - Liquidation parameters
 * @returns Object containing instructions and derived mints
 */
export async function buildKaminoLiquidationIxs(p: BuildKaminoLiquidationParams): Promise<KaminoLiquidationResult> {
  // Create @solana/kit RPC from connection URL for Kamino SDK compatibility
  // Cast to any to avoid type identity mismatches from duplicate @solana/addresses versions
  const rpc = createSolanaRpc(p.connection.rpcEndpoint) as unknown as any;
  
  // 1) Load market from Kamino SDK
  const market = await KaminoMarket.load(
    rpc,
    address(p.marketPubkey.toBase58()),
    1000, // recentSlotDurationMs
    address(p.programId.toBase58())
  );
  
  if (!market) {
    throw new Error(`Failed to load Kamino market: ${p.marketPubkey.toBase58()}`);
  }
  
  // 1) Load obligation using the market instance (SDK overload expects KaminoMarket)
  const obligation = await KaminoObligation.load(
    market,
    address(p.obligationPubkey.toBase58())
  );
  
  if (!obligation) {
    throw new Error(`Failed to load obligation: ${p.obligationPubkey.toBase58()}`);
  }
  
  // 2) Select repay reserve from obligation borrows
  // PR: Strategy - prioritize expected reserve pubkey (deterministic), fallback to preference or highest USD
  let repayReserve;
  let repayMint: PublicKey | null = null;
  
  const depositsAll = obligation.state.deposits.filter((d: any) =>
    d.depositReserve.toString() !== PublicKey.default.toString()
  ); // SDK obligation state doesn't export specific types
  const borrowsAll = obligation.state.borrows.filter((b: any) =>
    b.borrowReserve.toString() !== PublicKey.default.toString()
  ); // SDK obligation state doesn't export specific types
  const deposits = depositsAll.filter((d: any) => gtZero(d.depositedAmount)); // ACTIVE = nonzero amount
  const borrows = borrowsAll.filter((b: any) => gtZero(b.borrowedAmountSf)); // ACTIVE = nonzero amount
  
  if (borrows.length === 0) {
    throw new Error(`Obligation ${p.obligationPubkey.toBase58()} has no active borrows`);
  }
  
  // PR: Prioritize expected reserve pubkey if provided (deterministic selection)
  if (p.expectedRepayReservePubkey) {
    const expectedReservePubkey = p.expectedRepayReservePubkey.toBase58();
    console.log(`[LiqBuilder] Using deterministic repay reserve from plan: ${expectedReservePubkey}`);
    
    // Validate that obligation has a borrow leg for this reserve
    const borrowHasReserve = borrows.some((b: any) => b.borrowReserve.toString() === expectedReservePubkey); // SDK type
    if (!borrowHasReserve) {
      throw new Error(
        `[LiqBuilder] preflight_reserve_mismatch: Expected repay reserve ${expectedReservePubkey} ` +
        `not found in obligation ${p.obligationPubkey.toBase58()} borrows`
      );
    }
    
    // Load reserve directly from market
    repayReserve = market.getReserveByAddress(address(expectedReservePubkey));
    if (!repayReserve) {
      throw new Error(
        `[LiqBuilder] Failed to load expected repay reserve ${expectedReservePubkey} from market`
      );
    }
    
    repayMint = new PublicKey(repayReserve.getLiquidityMint());
  } else if (p.repayMintPreference) {
    // Fallback to mint preference
    for (const borrow of borrows) {
      const reserve = market.getReserveByAddress(address(borrow.borrowReserve.toString()));
      if (reserve && reserve.getLiquidityMint() === p.repayMintPreference.toBase58()) {
        repayReserve = reserve;
        repayMint = p.repayMintPreference;
        break;
      }
    }
    
    if (!repayReserve) {
      throw new Error(
        `No borrow found matching repayMintPreference ${p.repayMintPreference.toBase58()} ` +
        `in obligation ${p.obligationPubkey.toBase58()}`
      );
    }
  } else {
    // Final fallback: select borrow with highest USD value
    // NOTE: This uses float math and may be nondeterministic - prefer providing expectedRepayReservePubkey
    console.log(`[LiqBuilder] Warning: Using USD-based reserve selection (nondeterministic) - prefer providing expectedRepayReservePubkey in plan`);
    let maxBorrowValue = 0;
    
    for (const borrow of borrows) {
      const reserve = market.getReserveByAddress(address(borrow.borrowReserve.toString()));
      if (reserve) {
        // Get borrow value in USD using oracle price
        const borrowedAmountSf = borrow.borrowedAmountSf.toString();
        const price = reserve.getOracleMarketPrice().toNumber();
        const decimals = reserve.stats.decimals;
        
        // Rough USD value estimate (SDK should provide better methods)
        const borrowValue = (Number(borrowedAmountSf) / 1e18) * (price / Math.pow(10, decimals));
        
        if (borrowValue > maxBorrowValue) {
          maxBorrowValue = borrowValue;
          repayReserve = reserve;
          repayMint = new PublicKey(reserve.getLiquidityMint());
        }
      }
    }
    
    if (!repayReserve) {
      throw new Error(`Could not select repay reserve from obligation borrows`);
    }
  }
  
  // 3) Select collateral reserve from obligation deposits
  // Strategy: Select deposit with highest USD value (or first non-zero)
  let collateralReserve;
  let collateralMint: PublicKey | null = null;
  
  if (deposits.length === 0) {
    throw new Error(`Obligation ${p.obligationPubkey.toBase58()} has no active deposits`);
  }
  
  // PR: Prioritize expected reserve pubkey if provided (deterministic selection)
  if (p.expectedCollateralReservePubkey) {
    const expectedReservePubkey = p.expectedCollateralReservePubkey.toBase58();
    console.log(`[LiqBuilder] Using deterministic collateral reserve from plan: ${expectedReservePubkey}`);
    
    // Validate that obligation has a deposit leg for this reserve
    const depositHasReserve = deposits.some((d: any) => d.depositReserve.toString() === expectedReservePubkey); // SDK type
    if (!depositHasReserve) {
      throw new Error(
        `[LiqBuilder] preflight_reserve_mismatch: Expected collateral reserve ${expectedReservePubkey} ` +
        `not found in obligation ${p.obligationPubkey.toBase58()} deposits`
      );
    }
    
    // Load reserve directly from market
    collateralReserve = market.getReserveByAddress(address(expectedReservePubkey));
    if (!collateralReserve) {
      throw new Error(
        `[LiqBuilder] Failed to load expected collateral reserve ${expectedReservePubkey} from market`
      );
    }
    
    collateralMint = new PublicKey(collateralReserve.getLiquidityMint());
  } else {
    // Fallback: select deposit with highest USD value
    // NOTE: This uses float math and may be nondeterministic - prefer providing expectedCollateralReservePubkey
    console.log(`[LiqBuilder] Warning: Using USD-based collateral selection (nondeterministic) - prefer providing expectedCollateralReservePubkey in plan`);
    let maxDepositValue = 0;
    
    for (const deposit of deposits) {
      const reserve = market.getReserveByAddress(address(deposit.depositReserve.toString()));
      if (reserve) {
        // Get deposit value in USD using oracle price
        const depositedAmount = deposit.depositedAmount.toString();
        const price = reserve.getOracleMarketPrice().toNumber();
        const decimals = reserve.stats.decimals;
        
        // Rough USD value estimate
        const depositValue = (Number(depositedAmount) / Math.pow(10, decimals)) * price;
        
        if (depositValue > maxDepositValue) {
          maxDepositValue = depositValue;
          collateralReserve = reserve;
          collateralMint = new PublicKey(reserve.getLiquidityMint());
        }
      }
    }
    
    if (!collateralReserve) {
      throw new Error(`Could not select collateral reserve from obligation deposits`);
    }
  }
  
  // Ensure mints are definitely assigned before use
  if (!repayMint) {
    throw new Error('[LiqBuilder] Could not determine repayMint from obligation borrows');
  }
  if (!collateralMint) {
    throw new Error('[LiqBuilder] Could not determine collateralMint from obligation deposits');
  }
  
  console.log(`[LiqBuilder] Selected repay: ${repayMint.toBase58()}, collateral: ${collateralMint.toBase58()}`);
  
  // PR: Strict preflight validation - check that selected reserves match expected reserves from plan
  // NOTE: This validation is now redundant when using expectedRepayReservePubkey/expectedCollateralReservePubkey
  // but kept for backward compatibility with old plans that don't provide expected reserves
  if (p.expectedRepayReservePubkey && !p.expectedRepayReservePubkey.equals(new PublicKey(repayReserve.address))) {
    throw new Error(
      `[LiqBuilder] Preflight validation failed: repay reserve mismatch. ` +
      `Expected: ${p.expectedRepayReservePubkey.toBase58()}, ` +
      `Selected: ${repayReserve.address}. ` +
      `This obligation's borrows don't match the planned reserves.`
    );
  }
  
  if (p.expectedCollateralReservePubkey && !p.expectedCollateralReservePubkey.equals(new PublicKey(collateralReserve.address))) {
    throw new Error(
      `[LiqBuilder] Preflight validation failed: collateral reserve mismatch. ` +
      `Expected: ${p.expectedCollateralReservePubkey.toBase58()}, ` +
      `Selected: ${collateralReserve.address}. ` +
      `This obligation's deposits don't match the planned reserves.`
    );
  }
  
  // PR: Log additional validation info for debugging
  if (p.expectedRepayReservePubkey || p.expectedCollateralReservePubkey) {
    console.log(`[LiqBuilder] Preflight validation passed: reserves match plan`);
    if (p.expectedRepayReservePubkey) {
      console.log(`[LiqBuilder]   Repay reserve validated: ${p.expectedRepayReservePubkey.toBase58()}`);
    }
    if (p.expectedCollateralReservePubkey) {
      console.log(`[LiqBuilder]   Collateral reserve validated: ${p.expectedCollateralReservePubkey.toBase58()}`);
    }
  }
  
  const depositReserveKeys = deposits.map((d: any) => d.depositReserve.toString());
  const borrowReserveKeys = borrows.map((b: any) => b.borrowReserve.toString());
  const refreshObligationReserves = depositReserveKeys.concat(borrowReserveKeys);
  const uniqueReserves: string[] = [];
  const seen = new Set<string>();
  for (const r of refreshObligationReserves) {
    if (!seen.has(r)) {
      uniqueReserves.push(r);
      seen.add(r);
    }
  }
  console.log(`[LiqBuilder] deposits=${depositReserveKeys.length} borrows=${borrowReserveKeys.length} refreshObligationReserves=${refreshObligationReserves.length} uniqueReserves=${uniqueReserves.length}`);
  const dbg = process.env.DEBUG_REFRESH_OBLIGATION === '1';
  if (dbg) {
    console.log(`[LiqBuilder][DEBUG_REFRESH_OBLIGATION] depositsAll(non-default)=${depositsAll.length} depositsActive(nonzero)=${deposits.length}`);
    console.log(`[LiqBuilder][DEBUG_REFRESH_OBLIGATION] borrowsAll(non-default)=${borrowsAll.length} borrowsActive(nonzero)=${borrows.length}`);
    console.log('\n[LiqBuilder][DEBUG_REFRESH_OBLIGATION] Obligation slot dump');
    console.log(`[LiqBuilder][DEBUG_REFRESH_OBLIGATION] obligation=${p.obligationPubkey.toBase58()}`);
    console.log(`[LiqBuilder][DEBUG_REFRESH_OBLIGATION] market=${p.marketPubkey.toBase58()}`);
    console.log(`[LiqBuilder][DEBUG_REFRESH_OBLIGATION] repayExpected=${p.expectedRepayReservePubkey?.toBase58() ?? 'none'}`);
    console.log(`[LiqBuilder][DEBUG_REFRESH_OBLIGATION] collateralExpected=${p.expectedCollateralReservePubkey?.toBase58() ?? 'none'}`);

    console.log('[LiqBuilder][DEBUG_REFRESH_OBLIGATION] deposits (slot order):');
    deposits.forEach((d: any, i: number) => {
      const reserve = d.depositReserve?.toString?.() ?? String(d.depositReserve);
      const amt = d.depositedAmount?.toString?.() ?? String(d.depositedAmount ?? 'unknown');
      console.log(`  [${i}] reserve=${reserve} depositedAmount=${amt}`);
    });

    console.log('[LiqBuilder][DEBUG_REFRESH_OBLIGATION] borrows (slot order):');
    borrows.forEach((b: any, i: number) => {
      const reserve = b.borrowReserve?.toString?.() ?? String(b.borrowReserve);
      const amtSf = b.borrowedAmountSf?.toString?.() ?? String(b.borrowedAmountSf ?? 'unknown');
      console.log(`  [${i}] reserve=${reserve} borrowedAmountSf=${amtSf}`);
    });

    console.log('[LiqBuilder][DEBUG_REFRESH_OBLIGATION] refresh remaining reserves (deposits→borrows, non-deduped):');
    refreshObligationReserves.forEach((r, i) => console.log(`  [${i}] ${r}`));
    console.log('');
  }
  
  // Validate that expected reserves are in the unique set
  if (p.expectedRepayReservePubkey) {
    const expectedRepayStr = p.expectedRepayReservePubkey.toBase58();
    if (!uniqueReserves.includes(expectedRepayStr)) {
      throw new Error(
        `[LiqBuilder] Expected repay reserve ${expectedRepayStr} not found in obligation reserves. ` +
        `This should have been caught earlier - logic error.`
      );
    }
  }
  
  if (p.expectedCollateralReservePubkey) {
    const expectedCollateralStr = p.expectedCollateralReservePubkey.toBase58();
    if (!uniqueReserves.includes(expectedCollateralStr)) {
      throw new Error(
        `[LiqBuilder] Expected collateral reserve ${expectedCollateralStr} not found in obligation reserves. ` +
        `This should have been caught earlier - logic error.`
      );
    }
  }
  
  // Get reserve states early - needed for mint resolution and later for refresh/liquidation ixs
  const repayReserveState = repayReserve.state;
  const collateralReserveState = collateralReserve.state;
  
  // Determine mints for ATA creation
  const repayLiquidityMint = new PublicKey(repayReserve.getLiquidityMint());
  const withdrawLiquidityMint = new PublicKey(collateralReserve.getLiquidityMint());
  const withdrawCollateralMint = new PublicKey(collateralReserveState.collateral.mintPubkey);
  
  // Resolve token program IDs from mint owners (source of truth)
  console.log('[LiqBuilder] Resolving token program IDs...');
  const repayTokenProgramId = await resolveTokenProgramId(p.connection, repayLiquidityMint);
  const withdrawLiquidityTokenProgramId = await resolveTokenProgramId(p.connection, withdrawLiquidityMint);
  const collateralTokenProgramId = await resolveTokenProgramId(p.connection, withdrawCollateralMint);
  
  console.log(`[LiqBuilder] Token programs - repay: ${repayTokenProgramId.toBase58().slice(0, 8)}..., withdrawLiq: ${withdrawLiquidityTokenProgramId.toBase58().slice(0, 8)}..., collateral: ${collateralTokenProgramId.toBase58().slice(0, 8)}...`);
  
  // Derive user ATAs for liquidator
  // The third parameter (false) indicates the owner is NOT a PDA (Program Derived Address)
  const userSourceLiquidityAta = getAssociatedTokenAddressSync(
    repayLiquidityMint,
    p.liquidatorPubkey,
    false, // allowOwnerOffCurve: owner is not a PDA
    repayTokenProgramId
  );
  
  const userDestinationCollateralAta = getAssociatedTokenAddressSync(
    withdrawCollateralMint,
    p.liquidatorPubkey,
    false, // allowOwnerOffCurve: owner is not a PDA
    collateralTokenProgramId
  );
  
  const userDestinationLiquidityAta = getAssociatedTokenAddressSync(
    withdrawLiquidityMint,
    p.liquidatorPubkey,
    false, // allowOwnerOffCurve: owner is not a PDA
    withdrawLiquidityTokenProgramId
  );
  
  // TX Size Fix: Check ATA existence before creating instructions
  // Only create ATAs that don't exist to keep liquidation TX small
  console.log('[LiqBuilder] Checking ATA existence...');
  
  const ataChecks: Array<{ name: 'repay' | 'collateral' | 'withdrawLiq'; ata: PublicKey; mint: PublicKey; tokenProgram: PublicKey }> = [
    { name: 'repay', ata: userSourceLiquidityAta, mint: repayLiquidityMint, tokenProgram: repayTokenProgramId },
    { name: 'collateral', ata: userDestinationCollateralAta, mint: withdrawCollateralMint, tokenProgram: collateralTokenProgramId },
    { name: 'withdrawLiq', ata: userDestinationLiquidityAta, mint: withdrawLiquidityMint, tokenProgram: withdrawLiquidityTokenProgramId },
  ];
  
  // Optimized: Single RPC call to check all ATAs at once (vs 3 sequential calls)
  const ataAddresses = ataChecks.map(c => c.ata);
  const accountInfos = await p.connection.getMultipleAccountsInfo(ataAddresses);
  
  const setupIxs: TransactionInstruction[] = [];
  const setupAtaNames: string[] = [];
  const missingAtas: Array<{ mint: string; ataAddress: string; purpose: 'repay' | 'collateral' | 'withdrawLiq' }> = [];
  
  for (let i = 0; i < ataChecks.length; i++) {
    const check = ataChecks[i];
    const accountInfo = accountInfos[i];
    
    if (!accountInfo) {
      console.log(`[LiqBuilder] ATA ${check.name} does not exist: ${check.ata.toBase58()}, adding to setupIxs`);
      setupIxs.push(buildCreateAtaIdempotentIx({
        payer: p.liquidatorPubkey,
        owner: p.liquidatorPubkey,
        ata: check.ata,
        mint: check.mint,
        tokenProgramId: check.tokenProgram,
      }));
      setupAtaNames.push(check.name);
      missingAtas.push({
        mint: check.mint.toBase58(),
        ataAddress: check.ata.toBase58(),
        purpose: check.name,
      });
    } else {
      console.log(`[LiqBuilder] ATA ${check.name} exists: ${check.ata.toBase58()}`);
    }
  }
  
  if (setupIxs.length > 0) {
    console.log(`[LiqBuilder] Created ${setupIxs.length} ATA setup instructions (missing ATAs)`);
  } else {
    console.log(`[LiqBuilder] All ATAs exist, no setup instructions needed`);
  }
  
  const liquidationIxs: TransactionInstruction[] = [];
  
  // TX Size Fix: DO NOT add ATA creates to liquidationIxs
  // They will be sent in a separate setup transaction if needed
  
  // PART B: Build refresh instructions in CANONICAL ORDER per KLend check_refresh validation
  // 
  // ARCHITECTURE (per KLend's strict adjacency rules):
  // 
  // PRE BLOCK (contiguous, immediately before liquidation):
  //   1. RefreshReserve(collateral/withdraw reserve) - for RefreshObligation slot freshness (6009)
  //   2. RefreshReserve(repay/debt reserve) - for RefreshObligation slot freshness (6009)
  //   3. RefreshObligation - now finds fresh reserves from steps 1-2
  //   4. RefreshFarms (0-2 instructions for collateral mode=0 and/or debt mode=1, if farms exist)
  // 
  // LIQUIDATE:
  //   5. LiquidateObligationAndRedeemReserveCollateral
  // 
  // POST BLOCK (immediately after liquidation):
  //   6. RefreshFarms (same farm set and order as PRE block step 4)
  // 
  // KEY CHANGES vs previous implementation:
  // - Removed POST reserve refresh instructions entirely (they broke adjacency)
  // - Added POST farms refresh (mirrors PRE farms) immediately after liquidation
  // - check_refresh validates: last instruction before liquidation = farms refresh (or obligation if no farms)
  // - check_refresh validates: first instruction after liquidation = farms refresh (or none if no farms)
  
  const DEFAULT_PUBKEY = "11111111111111111111111111111111";
  
  // Helper to build refresh instruction for a reserve
  const buildRefreshReserveIx = (reservePubkeyStr: string, label: string): TransactionInstruction => {
    const reserve = market.getReserveByAddress(address(reservePubkeyStr));
    if (!reserve) {
      throw new Error(`[LiqBuilder] Failed to load reserve ${reservePubkeyStr} from market for refresh`);
    }
    
    const reserveState = reserve.state;
    const sdkIx = refreshReserve({
      reserve: reserve.address,
      lendingMarket: address(p.marketPubkey.toBase58()),
      pythOracle: (reserveState.config.tokenInfo.pythConfiguration.price && 
                   reserveState.config.tokenInfo.pythConfiguration.price !== DEFAULT_PUBKEY) ? 
        some(reserveState.config.tokenInfo.pythConfiguration.price) : none(),
      switchboardPriceOracle: (reserveState.config.tokenInfo.switchboardConfiguration.priceAggregator &&
                               reserveState.config.tokenInfo.switchboardConfiguration.priceAggregator !== DEFAULT_PUBKEY) ?
        some(reserveState.config.tokenInfo.switchboardConfiguration.priceAggregator) : none(),
      switchboardTwapOracle: (reserveState.config.tokenInfo.switchboardConfiguration.twapAggregator &&
                             reserveState.config.tokenInfo.switchboardConfiguration.twapAggregator !== DEFAULT_PUBKEY) ?
        some(reserveState.config.tokenInfo.switchboardConfiguration.twapAggregator) : none(),
      scopePrices: (reserveState.config.tokenInfo.scopeConfiguration.priceFeed &&
                   reserveState.config.tokenInfo.scopeConfiguration.priceFeed !== DEFAULT_PUBKEY) ?
        some(reserveState.config.tokenInfo.scopeConfiguration.priceFeed) : none(),
    }, [], address(p.programId.toBase58()));
    
    return new TransactionInstruction({
      keys: (sdkIx.accounts || []).map((a: SdkAccount) => convertSdkAccount(a, label)),
      programId: new PublicKey(addressSafe(sdkIx.programAddress, `${label}.programAddress`)),
      data: Buffer.from(sdkIx.data || []),
    });
  };
  
  // ========================================================================
  // STEP 1: Build PRE-RESERVE refresh instructions (for RefreshObligation slot freshness)
  // Order: selected obligation reserves in canonical deposits→borrows order
  // ========================================================================
  const mode = p.preReserveRefreshMode ?? 'all';
  const primarySet = new Set([repayReserve.address.toString(), collateralReserve.address.toString()]);
  const maxFullParsed = Number(process.env.PRE_RESERVE_FULL_REFRESH_MAX_RESERVES ?? DEFAULT_PRE_RESERVE_FULL_REFRESH_MAX_RESERVES);
  const maxFull = Number.isFinite(maxFullParsed) && maxFullParsed > 0
    ? maxFullParsed
    : DEFAULT_PRE_RESERVE_FULL_REFRESH_MAX_RESERVES;
  const reservesToRefresh = mode === 'all'
    ? uniqueReserves
    : mode === 'primary'
      ? uniqueReserves.filter(r => primarySet.has(r))
      : uniqueReserves.length <= maxFull
        ? uniqueReserves
        : uniqueReserves.filter(r => primarySet.has(r));
  console.log(`[LiqBuilder] preReserveRefreshMode=${mode}, uniqueReserves=${uniqueReserves.length}, reservesToRefresh=${reservesToRefresh.length}`);
  const preReserveIxs: TransactionInstruction[] = [];
  for (let i = 0; i < reservesToRefresh.length; i++) {
    const r = reservesToRefresh[i];
    console.log(`[LiqBuilder] Building PRE-RESERVE RefreshReserve for reserve[${i}] ${r}`);
    preReserveIxs.push(buildRefreshReserveIx(r, `preRefreshReserve:${i}`));
  }
  
  // ========================================================================
  // STEP 2: Build CORE instructions (RefreshObligation + RefreshFarms)
  // ========================================================================
  const coreIxs: TransactionInstruction[] = [];
  
  // STEP 2A: RefreshObligation with ALL reserves as remaining accounts
  // Convert reserve pubkeys to AccountMeta format for SDK
  // According to Kamino SDK, reserves passed as remaining accounts should be read-only (role 0)
  const remainingAccounts = refreshObligationReserves.map(r => ({
    address: address(r),
    role: AccountRole.READONLY,
  }));

  const referrerRaw = (obligation.state as any).referrer;
  const referrerPk = parsePublicKeyish(referrerRaw);

  const hasReferrer = !!referrerPk && !referrerPk.equals(PublicKey.default);

  if (dbg) {
    console.log(`[LiqBuilder][DEBUG_REFRESH_OBLIGATION] referrerRawType=${typeof referrerRaw}`);
    console.log(`[LiqBuilder][DEBUG_REFRESH_OBLIGATION] referrerParsed=${referrerPk ? referrerPk.toBase58() : 'null'}`);
    if (referrerRaw && (referrerRaw as { length?: number })?.length === 32) {
      console.log(`[LiqBuilder][DEBUG_REFRESH_OBLIGATION] referrerRawLen=32 (likely bytes)`);
    }
  }

  if (hasReferrer) {
    for (const borrowReserve of borrowReserveKeys) {
      const reservePk = new PublicKey(borrowReserve);
      const [pda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("referrer_acc"),
          referrerPk!.toBuffer(),
          reservePk.toBuffer(),
        ],
        p.programId,
      );
      remainingAccounts.push({
        address: address(pda.toBase58()),
        role: AccountRole.WRITABLE,
      });
    }
    console.log(`[LiqBuilder] obligation has referrer=${referrerPk!.toBase58()} -> appended ${borrowReserveKeys.length} referrer token states`);
  }

  const expectedRemainingAccounts = depositReserveKeys.length + borrowReserveKeys.length + (hasReferrer ? borrowReserveKeys.length : 0);
  if (remainingAccounts.length !== expectedRemainingAccounts) {
    throw new Error(
      `[LiqBuilder] refreshObligation remaining accounts mismatch expected=${expectedRemainingAccounts} actual=${remainingAccounts.length} ` +
      `deposits=${depositReserveKeys.length} borrows=${borrowReserveKeys.length} hasReferrer=${hasReferrer}`
    );
  }
  
  console.log(`[LiqBuilder] Building RefreshObligation with ${remainingAccounts.length} remaining accounts`);
  
  const obligationRefreshIx = refreshObligation({
    lendingMarket: address(p.marketPubkey.toBase58()),
    obligation: address(p.obligationPubkey.toBase58()),
  }, remainingAccounts, address(p.programId.toBase58()));
  
  coreIxs.push(new TransactionInstruction({
    keys: (obligationRefreshIx.accounts || []).map((a: SdkAccount) => convertSdkAccount(a, 'obligationRefresh')),
    programId: new PublicKey(addressSafe(obligationRefreshIx.programAddress, 'obligationRefresh.programAddress')),
    data: Buffer.from(obligationRefreshIx.data || []),
  }));
  
  // STEP 2B: Build RefreshFarms instructions (for both collateral and debt if farms exist)
  // These will be mirrored in POST block immediately after liquidation
  const preFarmIxs: TransactionInstruction[] = [];
  const postFarmIxs: TransactionInstruction[] = [];
  const farmModes: number[] = [];
  const farmRequiredModes: number[] = [];
  const collateralFarmState = collateralReserve.state.farmCollateral;
  if (collateralFarmState !== DEFAULT_PUBKEY) farmRequiredModes.push(0);
  const debtFarmState = repayReserve.state.farmDebt;
  if (debtFarmState !== DEFAULT_PUBKEY) farmRequiredModes.push(1);
  if (!p.disableFarmsRefresh) {
    // Check collateral reserve farm (mode 0)
    if (collateralFarmState !== DEFAULT_PUBKEY) {
    console.log(`[LiqBuilder] Building RefreshFarms for collateral reserve (mode=0)`);
    
    const obligationFarmUserState = await obligationFarmStatePda(
      address(collateralFarmState),
      address(p.obligationPubkey.toBase58())
    );
    
    const lendingMarketAuthority = await market.getLendingMarketAuthority();
    
    const crankSigner = {
      address: address(p.liquidatorPubkey.toBase58()),
    };
    
    const refreshFarmsIx = refreshObligationFarmsForReserve(
      { mode: 0 }, // 0 = Collateral
      {
        crank: crankSigner as any,
        baseAccounts: {
          obligation: address(p.obligationPubkey.toBase58()),
          lendingMarketAuthority,
          reserve: collateralReserve.address,
          reserveFarmState: address(collateralFarmState),
          obligationFarmUserState,
          lendingMarket: address(p.marketPubkey.toBase58()),
        },
        farmsProgram: address(FARMS_PROGRAM_ID),
        rent: SYSVAR_RENT_ADDRESS,
        systemProgram: address(SYSTEM_PROGRAM_ID),
      },
      [],
      address(p.programId.toBase58())
    );
    
    const farmIx = new TransactionInstruction({
      keys: (refreshFarmsIx.accounts || []).map((a: SdkAccount) => convertSdkAccount(a, 'refreshFarms:collateral')),
      programId: new PublicKey(addressSafe(refreshFarmsIx.programAddress, 'refreshFarms.programAddress')),
      data: Buffer.from(refreshFarmsIx.data || []),
    });
    
    preFarmIxs.push(farmIx);
    // POST farms should be IDENTICAL to PRE farms (same instruction data and accounts)
    postFarmIxs.push(new TransactionInstruction({
      keys: farmIx.keys,
      programId: farmIx.programId,
      data: farmIx.data,
    }));
    farmModes.push(0);
    }
    
    // Check debt/repay reserve farm (mode 1)
    if (debtFarmState !== DEFAULT_PUBKEY) {
    console.log(`[LiqBuilder] Building RefreshFarms for debt reserve (mode=1)`);
    
    const obligationFarmUserState = await obligationFarmStatePda(
      address(debtFarmState),
      address(p.obligationPubkey.toBase58())
    );
    
    const lendingMarketAuthority = await market.getLendingMarketAuthority();
    
    const crankSigner = {
      address: address(p.liquidatorPubkey.toBase58()),
    };
    
    const refreshFarmsIx = refreshObligationFarmsForReserve(
      { mode: 1 }, // 1 = Debt
      {
        crank: crankSigner as any,
        baseAccounts: {
          obligation: address(p.obligationPubkey.toBase58()),
          lendingMarketAuthority,
          reserve: repayReserve.address,
          reserveFarmState: address(debtFarmState),
          obligationFarmUserState,
          lendingMarket: address(p.marketPubkey.toBase58()),
        },
        farmsProgram: address(FARMS_PROGRAM_ID),
        rent: SYSVAR_RENT_ADDRESS,
        systemProgram: address(SYSTEM_PROGRAM_ID),
      },
      [],
      address(p.programId.toBase58())
    );
    
    const farmIx = new TransactionInstruction({
      keys: (refreshFarmsIx.accounts || []).map((a: SdkAccount) => convertSdkAccount(a, 'refreshFarms:debt')),
      programId: new PublicKey(addressSafe(refreshFarmsIx.programAddress, 'refreshFarms.programAddress')),
      data: Buffer.from(refreshFarmsIx.data || []),
    });
    
    preFarmIxs.push(farmIx);
    // POST farms should be IDENTICAL to PRE farms (same instruction data and accounts)
    postFarmIxs.push(new TransactionInstruction({
      keys: farmIx.keys,
      programId: farmIx.programId,
      data: farmIx.data,
    }));
    farmModes.push(1);
    }
  }
  
  // Add PRE farm instructions to core (immediately after RefreshObligation)
  coreIxs.push(...preFarmIxs);
  
  console.log(`[LiqBuilder] Built ${preFarmIxs.length} RefreshFarms instructions (modes: ${farmModes.join(', ')})`);
  console.log(`[LiqBuilder] POST farms will mirror PRE farms (${postFarmIxs.length} instructions)`);

  // 4) Derive repay amount
  // If repayAmountUi provided, convert to base units with exact string→integer conversion
  // Else, derive from borrow amount and clamp to protocol-safe maximum
  const repayDecimals = repayReserve.stats.decimals;
  let liquidityAmount: BN;
  
  if (p.repayAmountUi) {
    // Use provided UI amount with exact conversion
    const baseUnitsBigint = parseUiAmountToBaseUnits(p.repayAmountUi, repayDecimals);
    liquidityAmount = new BN(baseUnitsBigint.toString());
  } else {
    // Derive from borrow amount
    // Find the borrow leg matching our selected repay reserve
    const repayBorrow = borrows.find(b => 
      b.borrowReserve.toString() === repayReserve.address
    );
    
    if (!repayBorrow) {
      throw new Error(
        `Cannot derive repay amount: no borrow found for repay reserve ${repayReserve.address}. ` +
        `Please provide repayAmountUi explicitly.`
      );
    }
    
    // Get borrowed amount in base units (this is scaled by cumulative borrow rate)
    // For safety, we'll repay a portion of the debt (e.g., 50% close factor)
    const borrowedAmountSf = repayBorrow.borrowedAmountSf;
    const cumulativeBorrowRate = repayReserve.state.liquidity.cumulativeBorrowRateBsf;
    
    // Convert from scaled fraction to base units using bigint-based math
    // borrowedAmountSf is in 1e18 scale, need to convert using cumulative borrow rate
    // borrowAmount = borrowedAmountSf * cumulativeBorrowRate / 10^18 / 10^18
    try {
      const borrowedSf = toBigInt(borrowedAmountSf);
      const cumRateBsf = toBigInt(cumulativeBorrowRate);
      
      const SCALE_1E18 = 10n ** 18n;
      const borrowAmountBaseBig = (borrowedSf * cumRateBsf) / SCALE_1E18 / SCALE_1E18;
      
      // Close factor typically 50% for Kamino (500 parts per thousand)
      const closeFactorPermille = 500n; // 50% = 500/1000
      const liquidityBaseBig = (borrowAmountBaseBig * closeFactorPermille) / 1000n;
      
      // Ensure we have a minimum amount
      if (liquidityBaseBig === 0n) {
        throw new Error(
          `Derived repay amount is zero. Borrow may be too small to liquidate. ` +
          `Please provide repayAmountUi explicitly.`
        );
      }
      
      liquidityAmount = new BN(liquidityBaseBig.toString());
      console.log(`[LiqBuilder] Derived repay amount: ${liquidityAmount.toString()} base units`);
    } catch (err) {
      console.error("[LiqBuilder] bigint conversion failed", {
        borrowedAmountSfType: typeof borrowedAmountSf,
        borrowedAmountSfRaw: borrowedAmountSf,
        cumulativeBorrowRateBsfType: typeof cumulativeBorrowRate,
        cumulativeBorrowRateBsfRaw: cumulativeBorrowRate,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
  
  // Set minimum acceptable received collateral (0 for now, can be configured)
  const minAcceptableReceivedLiquidityAmount = new BN(0);
  
  // Set max allowed LTV override (0 = no override, use default)
  const maxAllowedLtvOverridePercent = new BN(0);
  
  // Get market authority
  const lendingMarketAuthority = await market.getLendingMarketAuthority();
  
  // Create a minimal signer object for the SDK instruction builder
  // The SDK only needs the address to build the instruction; actual signing happens later
  // We use 'as any' here because we're just building instructions, not actually signing
  const liquidatorSigner = {
    address: address(p.liquidatorPubkey.toBase58()),
  } as any;
  
  // Use the resolved token programs and ATAs from earlier
  // Convert PublicKey to @solana/kit address for SDK compatibility
  const userSourceLiquidity = address(userSourceLiquidityAta.toBase58());
  const userDestinationCollateral = address(userDestinationCollateralAta.toBase58());
  const userDestinationLiquidity = address(userDestinationLiquidityAta.toBase58());
  
  const repayTokenProgram = address(repayTokenProgramId.toBase58());
  const collateralMintTokenProgram = address(collateralTokenProgramId.toBase58());
  const withdrawLiqTokenProgram = address(withdrawLiquidityTokenProgramId.toBase58());
  
  // D) Build liquidation instruction
  const liquidateIx = liquidateObligationAndRedeemReserveCollateral(
    {
      liquidityAmount,
      minAcceptableReceivedLiquidityAmount,
      maxAllowedLtvOverridePercent,
    },
    {
      liquidator: liquidatorSigner,
      obligation: address(p.obligationPubkey.toBase58()),
      lendingMarket: address(p.marketPubkey.toBase58()),
      lendingMarketAuthority,
      repayReserve: repayReserve.address,
      repayReserveLiquidityMint: repayReserve.getLiquidityMint(),
      repayReserveLiquiditySupply: repayReserveState.liquidity.supplyVault,
      withdrawReserve: collateralReserve.address,
      withdrawReserveLiquidityMint: collateralReserve.getLiquidityMint(),
      withdrawReserveCollateralMint: collateralReserveState.collateral.mintPubkey,
      withdrawReserveCollateralSupply: collateralReserveState.collateral.supplyVault,
      withdrawReserveLiquiditySupply: collateralReserveState.liquidity.supplyVault,
      withdrawReserveLiquidityFeeReceiver: collateralReserveState.liquidity.feeVault,
      userSourceLiquidity,
      userDestinationCollateral,
      userDestinationLiquidity,
      collateralTokenProgram: collateralMintTokenProgram,
      repayLiquidityTokenProgram: repayTokenProgram,
      withdrawLiquidityTokenProgram: withdrawLiqTokenProgram,
      instructionSysvarAccount: address(SYSVAR_INSTRUCTIONS_PUBKEY.toBase58()),
    },
    [],
    address(p.programId.toBase58())
  );
  
  // Convert SDK instruction to web3.js TransactionInstruction
  liquidationIxs.push(new TransactionInstruction({
    keys: (liquidateIx.accounts || []).map((a: SdkAccount) => convertSdkAccount(a, 'liquidate')),
    programId: new PublicKey(addressSafe(liquidateIx.programAddress, 'liquidate.programAddress')),
    data: Buffer.from(liquidateIx.data || []),
  }));
  
  // F) Return setup, refresh and liquidation instructions with derived mints
  return {
    setupIxs,
    setupAtaNames,
    missingAtas,
    preReserveIxs, // Reserve refreshes for slot freshness (all obligation reserves)
    coreIxs, // RefreshObligation + RefreshFarms (0-2 farm instructions)
    liquidationIxs, // LiquidateObligationAndRedeemReserveCollateral
    postFarmIxs, // RefreshFarms (mirrors PRE farms, immediately after liquidation)
    repayMint,
    collateralMint,
    withdrawCollateralMint, // Actual collateral mint used for redemption
    // Metadata for instruction labeling
    ataCount: setupIxs.length,
    farmRefreshCount: preFarmIxs.length,
    farmRequiredModes, // Farm modes required by reserve state: 0=collateral, 1=debt
    farmModes, // Farm modes included: 0=collateral, 1=debt
    // lookupTables: undefined, // Can be added later if needed
  };
}
