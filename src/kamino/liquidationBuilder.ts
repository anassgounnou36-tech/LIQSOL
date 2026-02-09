import { Connection, PublicKey, TransactionInstruction, Keypair, AddressLookupTableAccount, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { KaminoMarket, KaminoObligation, refreshReserve, refreshObligation, liquidateObligationAndRedeemReserveCollateral, getAssociatedTokenAddress } from "@kamino-finance/klend-sdk";
import { createSolanaRpc } from "@solana/rpc";
import { createKeyPairSignerFromBytes } from "@solana/signers";
import { AccountRole } from "@solana/instructions";
import type { Address } from "@solana/addresses";
import { none, some } from "@solana/options";
import { Buffer } from "node:buffer";
import BN from "bn.js";

/**
 * PR2: Parameters for building Kamino liquidation instructions.
 * Matches the spec: marketPubkey, programId, obligationPubkey, liquidatorPubkey, repayMint, repayAmountUi
 */
export interface BuildKaminoLiquidationParams {
  connection: Connection;
  marketPubkey: PublicKey;
  programId: PublicKey;
  
  // Obligation to liquidate
  obligationPubkey: PublicKey;
  
  // Liquidator/signer (PR2: renamed from 'liquidator' to align with spec)
  liquidator: Keypair;
  
  // Liquidation mints (PR2: repay mint from plan label or address)
  repayMint: PublicKey;
  collateralMint: PublicKey;
  
  // Optional: repay amount in UI units (will be converted to base units)
  repayAmountUi?: string;
}

/**
 * PR2: Result containing refresh and liquidation instructions
 */
export interface KaminoLiquidationResult {
  refreshIxs: TransactionInstruction[];
  liquidationIxs: TransactionInstruction[];
  lookupTables?: AddressLookupTableAccount[];
}

/**
 * PR2: Helper to convert UI amount string to base units (u64) with exact string→integer conversion (no float math)
 * @param amountUi - Amount in UI units as a string (e.g., "100.50")
 * @param decimals - Number of decimals for the mint
 * @returns Amount in base units as BN
 */
export function parseUiAmountToBaseUnits(amountUi: string, decimals: number): BN {
  // Split into integer and fractional parts
  const parts = amountUi.split('.');
  const integerPart = parts[0] || '0';
  const fractionalPart = parts[1] || '';
  
  // Pad or truncate fractional part to match decimals
  const paddedFractional = fractionalPart.padEnd(decimals, '0').slice(0, decimals);
  
  // Combine into a single integer string
  const baseUnitsStr = integerPart + paddedFractional;
  
  // Convert to BN (handles large numbers correctly)
  return new BN(baseUnitsStr, 10);
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
 * PR2: Build REAL Kamino liquidation instructions using SDK.
 * 
 * This is the complete implementation that:
 * A) Loads market + reserves using marketPubkey + programId (using @kamino-finance/klend-sdk)
 * B) Fetches and decodes obligation account
 * C) Determines repayReserve (borrowed reserve matching repayMint) and withdrawReserve (collateral reserve)
 * D) Derives accounts for refreshReserve, refreshObligation, and liquidateObligationAndRedeemReserveCollateral
 * E) Converts repayAmountUi → base units using exact string→integer conversion (no float math)
 * F) Returns refreshIxs + liquidationIxs (+ lookup tables if needed)
 * 
 * The liquidation process:
 * 1. Refresh repay reserve (updates oracle prices and interest rates)
 * 2. Refresh collateral reserve (updates oracle prices and interest rates)
 * 3. Refresh obligation (updates borrow and collateral values)
 * 4. Liquidate: Liquidator repays borrower's debt (repayMint) and receives collateral (collateralMint) + bonus
 * 
 * @param p - Liquidation parameters
 * @returns Object containing refreshIxs and liquidationIxs
 */
export async function buildKaminoLiquidationIxs(p: BuildKaminoLiquidationParams): Promise<KaminoLiquidationResult> {
  // Create @solana/kit RPC from connection URL for Kamino SDK compatibility
  const rpc = createSolanaRpc(p.connection.rpcEndpoint);
  
  // A) Load market from Kamino SDK
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
  
  // C) Get repay reserve by mint (borrowed asset)
  const repayReserve = market.getReserveByMint(p.repayMint.toBase58() as Address);
  if (!repayReserve) {
    throw new Error(`Repay reserve not found for mint: ${p.repayMint.toBase58()}`);
  }
  
  // C) Get collateral reserve by mint (collateral to seize)
  const collateralReserve = market.getReserveByMint(p.collateralMint.toBase58() as Address);
  if (!collateralReserve) {
    throw new Error(`Collateral reserve not found for mint: ${p.collateralMint.toBase58()}`);
  }
  
  // B) Load obligation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obligation = await KaminoObligation.load(
    rpc as any,
    p.obligationPubkey.toBase58() as Address
  );
  
  if (!obligation) {
    throw new Error(`Failed to load obligation: ${p.obligationPubkey.toBase58()}`);
  }
  
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
  
  // E) Convert repay amount from UI to base units (if provided, otherwise use a default)
  const repayDecimals = repayReserve.stats.decimals;
  const repayAmountUi = p.repayAmountUi || '100'; // Default to 100 UI units if not provided
  const liquidityAmount = parseUiAmountToBaseUnits(repayAmountUi, repayDecimals);
  
  // Set minimum acceptable received collateral (0 for now, can be configured)
  const minAcceptableReceivedLiquidityAmount = new BN(0);
  
  // Set max allowed LTV override (0 = no override, use default)
  const maxAllowedLtvOverridePercent = new BN(0);
  
  // Get market authority
  const lendingMarketAuthority = await market.getLendingMarketAuthority();
  
  // Convert liquidator Keypair to SDK signer
  const liquidatorSigner = await createKeyPairSignerFromBytes(p.liquidator.secretKey);
  
  // Get token programs
  const repayTokenProgram = repayReserve.getLiquidityTokenProgram();
  const collateralTokenProgram = collateralReserve.getLiquidityTokenProgram();
  const collateralMintTokenProgram = collateralReserve.getLiquidityTokenProgram(); // Same for collateral mint
  
  // Derive liquidator ATAs
  const userSourceLiquidity = await getAssociatedTokenAddress(
    repayReserve.getLiquidityMint(),
    p.liquidator.publicKey.toBase58() as Address,
    repayTokenProgram
  );
  
  const userDestinationCollateral = await getAssociatedTokenAddress(
    collateralReserveState.collateral.mintPubkey,
    p.liquidator.publicKey.toBase58() as Address,
    collateralMintTokenProgram
  );
  
  const userDestinationLiquidity = await getAssociatedTokenAddress(
    collateralReserve.getLiquidityMint(),
    p.liquidator.publicKey.toBase58() as Address,
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
  
  // F) Return refresh and liquidation instructions
  return {
    refreshIxs,
    liquidationIxs,
    // lookupTables: undefined, // Can be added later if needed
  };
}
