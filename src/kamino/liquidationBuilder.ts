import { Connection, PublicKey, TransactionInstruction, AddressLookupTableAccount, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { KaminoMarket, KaminoObligation, refreshReserve, refreshObligation, liquidateObligationAndRedeemReserveCollateral } from "@kamino-finance/klend-sdk";
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
import { toBigInt } from "../utils/bn.js";

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
}

/**
 * PR62: Result containing refresh and liquidation instructions
 * Now includes derived repayMint and collateralMint for downstream validation
 */
export interface KaminoLiquidationResult {
  refreshIxs: TransactionInstruction[];
  liquidationIxs: TransactionInstruction[];
  lookupTables?: AddressLookupTableAccount[];
  repayMint: PublicKey;
  collateralMint: PublicKey;
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
  
  const borrows = obligation.state.borrows.filter((b: any) => b.borrowReserve.toString() !== PublicKey.default.toString()); // SDK obligation state doesn't export specific types
  
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
  
  const deposits = obligation.state.deposits.filter((d: any) => d.depositReserve.toString() !== PublicKey.default.toString()); // SDK obligation state doesn't export specific types
  
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
  
  // Build ATA idempotent create instructions
  const ataCreateIxs: TransactionInstruction[] = [];
  
  ataCreateIxs.push(buildCreateAtaIdempotentIx({
    payer: p.liquidatorPubkey,
    owner: p.liquidatorPubkey,
    ata: userSourceLiquidityAta,
    mint: repayLiquidityMint,
    tokenProgramId: repayTokenProgramId,
  }));
  
  ataCreateIxs.push(buildCreateAtaIdempotentIx({
    payer: p.liquidatorPubkey,
    owner: p.liquidatorPubkey,
    ata: userDestinationCollateralAta,
    mint: withdrawCollateralMint,
    tokenProgramId: collateralTokenProgramId,
  }));
  
  ataCreateIxs.push(buildCreateAtaIdempotentIx({
    payer: p.liquidatorPubkey,
    owner: p.liquidatorPubkey,
    ata: userDestinationLiquidityAta,
    mint: withdrawLiquidityMint,
    tokenProgramId: withdrawLiquidityTokenProgramId,
  }));
  
  console.log(`[LiqBuilder] Created ${ataCreateIxs.length} ATA idempotent instructions`);
  
  const refreshIxs: TransactionInstruction[] = [];
  const liquidationIxs: TransactionInstruction[] = [];
  
  // Prepend ATA create instructions to refreshIxs
  refreshIxs.push(...ataCreateIxs);
  
  // D) Build refresh instructions
  // 1. Refresh repay reserve
  const DEFAULT_PUBKEY = "11111111111111111111111111111111";
  const repayRefreshIx = refreshReserve({
    reserve: repayReserve.address,
    lendingMarket: address(p.marketPubkey.toBase58()),
    pythOracle: (repayReserveState.config.tokenInfo.pythConfiguration.price && 
                 repayReserveState.config.tokenInfo.pythConfiguration.price !== DEFAULT_PUBKEY) ? 
      some(repayReserveState.config.tokenInfo.pythConfiguration.price) : none(),
    switchboardPriceOracle: (repayReserveState.config.tokenInfo.switchboardConfiguration.priceAggregator &&
                             repayReserveState.config.tokenInfo.switchboardConfiguration.priceAggregator !== DEFAULT_PUBKEY) ?
      some(repayReserveState.config.tokenInfo.switchboardConfiguration.priceAggregator) : none(),
    switchboardTwapOracle: (repayReserveState.config.tokenInfo.switchboardConfiguration.twapAggregator &&
                           repayReserveState.config.tokenInfo.switchboardConfiguration.twapAggregator !== DEFAULT_PUBKEY) ?
      some(repayReserveState.config.tokenInfo.switchboardConfiguration.twapAggregator) : none(),
    scopePrices: (repayReserveState.config.tokenInfo.scopeConfiguration.priceFeed &&
                 repayReserveState.config.tokenInfo.scopeConfiguration.priceFeed !== DEFAULT_PUBKEY) ?
      some(repayReserveState.config.tokenInfo.scopeConfiguration.priceFeed) : none(),
  }, [], address(p.programId.toBase58()));
  
  refreshIxs.push(new TransactionInstruction({
    keys: (repayRefreshIx.accounts || []).map((a: SdkAccount) => convertSdkAccount(a, 'repayRefresh')),
    programId: new PublicKey(addressSafe(repayRefreshIx.programAddress, 'repayRefresh.programAddress')),
    data: Buffer.from(repayRefreshIx.data || []),
  }));
  
  // 2. Refresh collateral reserve
  const collateralRefreshIx = refreshReserve({
    reserve: collateralReserve.address,
    lendingMarket: address(p.marketPubkey.toBase58()),
    pythOracle: (collateralReserveState.config.tokenInfo.pythConfiguration.price &&
                 collateralReserveState.config.tokenInfo.pythConfiguration.price !== DEFAULT_PUBKEY) ?
      some(collateralReserveState.config.tokenInfo.pythConfiguration.price) : none(),
    switchboardPriceOracle: (collateralReserveState.config.tokenInfo.switchboardConfiguration.priceAggregator &&
                             collateralReserveState.config.tokenInfo.switchboardConfiguration.priceAggregator !== DEFAULT_PUBKEY) ?
      some(collateralReserveState.config.tokenInfo.switchboardConfiguration.priceAggregator) : none(),
    switchboardTwapOracle: (collateralReserveState.config.tokenInfo.switchboardConfiguration.twapAggregator &&
                           collateralReserveState.config.tokenInfo.switchboardConfiguration.twapAggregator !== DEFAULT_PUBKEY) ?
      some(collateralReserveState.config.tokenInfo.switchboardConfiguration.twapAggregator) : none(),
    scopePrices: (collateralReserveState.config.tokenInfo.scopeConfiguration.priceFeed &&
                 collateralReserveState.config.tokenInfo.scopeConfiguration.priceFeed !== DEFAULT_PUBKEY) ?
      some(collateralReserveState.config.tokenInfo.scopeConfiguration.priceFeed) : none(),
  }, [], address(p.programId.toBase58()));
  
  refreshIxs.push(new TransactionInstruction({
    keys: (collateralRefreshIx.accounts || []).map((a: SdkAccount) => convertSdkAccount(a, 'collateralRefresh')),
    programId: new PublicKey(addressSafe(collateralRefreshIx.programAddress, 'collateralRefresh.programAddress')),
    data: Buffer.from(collateralRefreshIx.data || []),
  }));
  
  // 3. Refresh obligation
  const obligationRefreshIx = refreshObligation({
    lendingMarket: address(p.marketPubkey.toBase58()),
    obligation: address(p.obligationPubkey.toBase58()),
  }, [], address(p.programId.toBase58()));
  
  refreshIxs.push(new TransactionInstruction({
    keys: (obligationRefreshIx.accounts || []).map((a: SdkAccount) => convertSdkAccount(a, 'obligationRefresh')),
    programId: new PublicKey(addressSafe(obligationRefreshIx.programAddress, 'obligationRefresh.programAddress')),
    data: Buffer.from(obligationRefreshIx.data || []),
  }));
  
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
  
  // F) Return refresh and liquidation instructions with derived mints
  return {
    refreshIxs,
    liquidationIxs,
    repayMint,
    collateralMint,
    // lookupTables: undefined, // Can be added later if needed
  };
}
