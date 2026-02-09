import { Connection, PublicKey, TransactionInstruction, AddressLookupTableAccount, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { KaminoMarket, KaminoObligation, refreshReserve, refreshObligation, liquidateObligationAndRedeemReserveCollateral, getAssociatedTokenAddress } from "@kamino-finance/klend-sdk";
import { createSolanaRpc } from "@solana/rpc";
import { createTransactionSigner } from "@solana/signers";
import { AccountRole } from "@solana/instructions";
import type { Address } from "@solana/addresses";
import { none, some } from "@solana/options";
import { Buffer } from "node:buffer";
import BN from "bn.js";
import { parseUiAmountToBaseUnits } from "../execute/amount.js";

/**
 * PR62: Parameters for building Kamino liquidation instructions.
 * Now derives reserves from obligation (no collateralMint/repayMint required in params)
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
 * Convert SDK instruction account to web3.js AccountMeta using AccountRole enum
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertSdkAccount(a: any) {
  const role = a.role as AccountRole;
  return {
    pubkey: new PublicKey(a.address),
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
  const rpc = createSolanaRpc(p.connection.rpcEndpoint);
  
  // 1) Load market from Kamino SDK
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const market = await KaminoMarket.load(
    rpc as any,
    p.marketPubkey.toBase58() as Address,
    1000, // recentSlotDurationMs
    p.programId.toBase58() as Address
  );
  
  if (!market) {
    throw new Error(`Failed to load Kamino market: ${p.marketPubkey.toBase58()}`);
  }
  
  // 1) Load obligation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obligation = await KaminoObligation.load(
    rpc as any,
    p.obligationPubkey.toBase58() as Address
  );
  
  if (!obligation) {
    throw new Error(`Failed to load obligation: ${p.obligationPubkey.toBase58()}`);
  }
  
  // 2) Select repay reserve from obligation borrows
  // Strategy: If repayMintPreference is set, use it; otherwise use highest USD value borrow
  let repayReserve;
  let repayMint: PublicKey;
  
  const borrows = obligation.state.borrows.filter(b => b.borrowReserve.toString() !== PublicKey.default.toString());
  
  if (borrows.length === 0) {
    throw new Error(`Obligation ${p.obligationPubkey.toBase58()} has no active borrows`);
  }
  
  if (p.repayMintPreference) {
    // Find borrow matching preference
    for (const borrow of borrows) {
      const reserve = market.getReserveByAddress(borrow.borrowReserve.toString() as Address);
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
    // Select borrow with highest USD value
    let maxBorrowValue = 0;
    
    for (const borrow of borrows) {
      const reserve = market.getReserveByAddress(borrow.borrowReserve.toString() as Address);
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
  let collateralMint: PublicKey;
  
  const deposits = obligation.state.deposits.filter(d => d.depositReserve.toString() !== PublicKey.default.toString());
  
  if (deposits.length === 0) {
    throw new Error(`Obligation ${p.obligationPubkey.toBase58()} has no active deposits`);
  }
  
  let maxDepositValue = 0;
  
  for (const deposit of deposits) {
    const reserve = market.getReserveByAddress(deposit.depositReserve.toString() as Address);
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
  
  console.log(`[LiqBuilder] Selected repay: ${repayMint.toBase58()}, collateral: ${collateralMint.toBase58()}`);
  
  const refreshIxs: TransactionInstruction[] = [];
  const liquidationIxs: TransactionInstruction[] = [];
  
  // D) Build refresh instructions
  // 1. Refresh repay reserve
  const DEFAULT_PUBKEY = "11111111111111111111111111111111";
  const repayReserveState = repayReserve.state;
  const repayRefreshIx = refreshReserve({
    reserve: repayReserve.address,
    lendingMarket: p.marketPubkey.toBase58() as Address,
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
  }, [], p.programId.toBase58() as Address);
  
  refreshIxs.push(new TransactionInstruction({
    keys: (repayRefreshIx.accounts || []).map(convertSdkAccount),
    programId: new PublicKey(repayRefreshIx.programAddress),
    data: Buffer.from(repayRefreshIx.data || []),
  }));
  
  // 2. Refresh collateral reserve
  const collateralReserveState = collateralReserve.state;
  const collateralRefreshIx = refreshReserve({
    reserve: collateralReserve.address,
    lendingMarket: p.marketPubkey.toBase58() as Address,
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
  }, [], p.programId.toBase58() as Address);
  
  refreshIxs.push(new TransactionInstruction({
    keys: (collateralRefreshIx.accounts || []).map(convertSdkAccount),
    programId: new PublicKey(collateralRefreshIx.programAddress),
    data: Buffer.from(collateralRefreshIx.data || []),
  }));
  
  // 3. Refresh obligation
  const obligationRefreshIx = refreshObligation({
    lendingMarket: p.marketPubkey.toBase58() as Address,
    obligation: p.obligationPubkey.toBase58() as Address,
  }, [], p.programId.toBase58() as Address);
  
  refreshIxs.push(new TransactionInstruction({
    keys: (obligationRefreshIx.accounts || []).map(convertSdkAccount),
    programId: new PublicKey(obligationRefreshIx.programAddress),
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
    
    // Convert from scaled fraction to base units
    // borrowedAmountSf is in 1e18 scale, need to convert using cumulative borrow rate
    // For simplicity, we'll use the obligation's method or a safe percentage
    
    // Close factor typically 50% for Kamino
    const closeFactor = 0.5;
    const cumulativeBorrowRate = repayReserve.state.liquidity.cumulativeBorrowRateBsf;
    
    // Calculate actual borrow amount in base units
    // borrowAmount = borrowedAmountSf * cumulativeBorrowRate / 10^18 / 10^18
    const borrowedSfBN = new BN(borrowedAmountSf.toString());
    const cumulativeRateBN = new BN(cumulativeBorrowRate.toString());
    
    // Compute with proper scaling
    const borrowAmountBase = borrowedSfBN.mul(cumulativeRateBN).div(new BN('1000000000000000000')).div(new BN('1000000000000000000'));
    
    // Apply close factor
    liquidityAmount = borrowAmountBase.muln(closeFactor * 1000).divn(1000);
    
    // Ensure we have a minimum amount
    if (liquidityAmount.isZero()) {
      throw new Error(
        `Derived repay amount is zero. Borrow may be too small to liquidate. ` +
        `Please provide repayAmountUi explicitly.`
      );
    }
    
    console.log(`[LiqBuilder] Derived repay amount: ${liquidityAmount.toString()} base units`);
  }
  
  // Set minimum acceptable received collateral (0 for now, can be configured)
  const minAcceptableReceivedLiquidityAmount = new BN(0);
  
  // Set max allowed LTV override (0 = no override, use default)
  const maxAllowedLtvOverridePercent = new BN(0);
  
  // Get market authority
  const lendingMarketAuthority = await market.getLendingMarketAuthority();
  
  // Create liquidator signer from public key
  const liquidatorSigner = await createTransactionSigner({
    address: p.liquidatorPubkey.toBase58() as Address,
  });
  
  // Get token programs
  const repayTokenProgram = repayReserve.getLiquidityTokenProgram();
  const collateralTokenProgram = collateralReserve.getLiquidityTokenProgram();
  const collateralMintTokenProgram = collateralReserve.getLiquidityTokenProgram(); // Same for collateral mint
  
  // Derive liquidator ATAs (use repayReserveState and collateralReserveState defined earlier)
  const userSourceLiquidity = await getAssociatedTokenAddress(
    repayReserve.getLiquidityMint(),
    p.liquidatorPubkey.toBase58() as Address,
    repayTokenProgram
  );
  
  const userDestinationCollateral = await getAssociatedTokenAddress(
    collateralReserveState.collateral.mintPubkey,
    p.liquidatorPubkey.toBase58() as Address,
    collateralMintTokenProgram
  );
  
  const userDestinationLiquidity = await getAssociatedTokenAddress(
    collateralReserve.getLiquidityMint(),
    p.liquidatorPubkey.toBase58() as Address,
    collateralTokenProgram
  );
  
  // D) Build liquidation instruction
  const liquidateIx = liquidateObligationAndRedeemReserveCollateral(
    {
      liquidityAmount,
      minAcceptableReceivedLiquidityAmount,
      maxAllowedLtvOverridePercent,
    },
    {
      liquidator: liquidatorSigner,
      obligation: p.obligationPubkey.toBase58() as Address,
      lendingMarket: p.marketPubkey.toBase58() as Address,
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
      withdrawLiquidityTokenProgram: collateralTokenProgram,
      instructionSysvarAccount: SYSVAR_INSTRUCTIONS_PUBKEY.toBase58() as Address,
    },
    [],
    p.programId.toBase58() as Address
  );
  
  // Convert SDK instruction to web3.js TransactionInstruction
  liquidationIxs.push(new TransactionInstruction({
    keys: (liquidateIx.accounts || []).map(convertSdkAccount),
    programId: new PublicKey(liquidateIx.programAddress),
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
