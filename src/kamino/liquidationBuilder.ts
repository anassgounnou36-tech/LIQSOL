import { Connection, PublicKey, TransactionInstruction, Keypair } from "@solana/web3.js";
import { KaminoMarket, KaminoObligation } from "@kamino-finance/klend-sdk";
import { createSolanaRpc } from "@solana/rpc";
import type { Address } from "@solana/addresses";
import type { ReserveCache } from "../cache/reserveCache.js";

export interface BuildKaminoLiquidationParams {
  connection: Connection;
  marketPubkey: PublicKey;
  programId: PublicKey;
  
  // Obligation to liquidate
  obligationPubkey: PublicKey;
  
  // Liquidation amounts and mints
  repayMint: PublicKey; // mint of the asset being repaid
  collateralMint: PublicKey; // mint of the collateral being seized
  repayAmountBaseUnits?: string; // repay amount in base units (optional, can derive from plan)
  
  // Liquidator/signer
  liquidator: Keypair; // the wallet performing the liquidation
  
  // Optional: reserve cache for deriving accounts (recommended)
  reserveCache?: ReserveCache;
}

export interface KaminoLiquidationResult {
  ixs: TransactionInstruction[];
  // Future: could include lookupTables, signers, etc.
}

/**
 * Build Kamino liquidation instructions (repay + seize) using SDK.
 * 
 * This uses the Kamino SDK's KaminoMarket and KaminoObligation to fetch
 * reserve and obligation data, then constructs the liquidation instruction.
 * 
 * The liquidation process:
 * 1. Liquidator repays a portion of the borrower's debt (repayMint asset)
 * 2. Liquidator receives the borrower's collateral (collateralMint asset) + bonus
 * 
 * All accounts are derived from on-chain data - no hardcoded addresses.
 * 
 * Note: This is a stub implementation. The actual Kamino SDK method names
 * and parameters may differ. This should be updated based on the actual SDK API.
 * 
 * @param p - Liquidation parameters including obligation, mints, and amounts
 * @returns Object containing liquidation instructions
 */
export async function buildKaminoLiquidationIxs(p: BuildKaminoLiquidationParams): Promise<KaminoLiquidationResult> {
  // Create @solana/kit RPC from connection URL for Kamino SDK compatibility
  const rpc = createSolanaRpc(p.connection.rpcEndpoint);
  
  // Load market from Kamino SDK
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const market = await KaminoMarket.load(
    rpc as any,
    p.marketPubkey.toBase58() as Address,
    1000 // recentSlotDurationMs
  );
  
  if (!market) {
    throw new Error(`Failed to load Kamino market: ${p.marketPubkey.toBase58()}`);
  }
  
  // Get repay reserve by mint
  const repayReserve = market.getReserveByMint(p.repayMint.toBase58() as Address);
  if (!repayReserve) {
    throw new Error(`Repay reserve not found for mint: ${p.repayMint.toBase58()}`);
  }
  
  // Get collateral reserve by mint
  const collateralReserve = market.getReserveByMint(p.collateralMint.toBase58() as Address);
  if (!collateralReserve) {
    throw new Error(`Collateral reserve not found for mint: ${p.collateralMint.toBase58()}`);
  }
  
  // Load obligation (Note: SDK may require different parameters)
  const obligation = await KaminoObligation.load(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc as any,
    p.obligationPubkey.toBase58() as Address
  );
  
  if (!obligation) {
    throw new Error(`Failed to load obligation: ${p.obligationPubkey.toBase58()}`);
  }
  
  // TODO: The actual Kamino SDK liquidation instruction builder method needs to be determined
  // This is a placeholder that demonstrates the structure.
  // The real SDK may have a method like: market.liquidateObligation() or similar
  throw new Error(
    'Kamino liquidation instruction builder not yet implemented. ' +
    'This requires the actual Kamino SDK method for building liquidation instructions. ' +
    'Please refer to @kamino-finance/klend-sdk documentation for the correct API.'
  );
}
