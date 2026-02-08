import { Connection, PublicKey, TransactionInstruction, Keypair } from "@solana/web3.js";
import { Buffer } from "node:buffer";
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
    1000, // recentSlotDurationMs
    p.programId.toBase58() as Address
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
  
  // Load obligation
  const obligation = await KaminoObligation.load(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc as any,
    p.obligationPubkey.toBase58() as Address,
    market
  );
  
  if (!obligation) {
    throw new Error(`Failed to load obligation: ${p.obligationPubkey.toBase58()}`);
  }
  
  // Build liquidation instruction using SDK
  // The SDK's getLiquidateObligationInstruction handles all account derivation
  const liquidateIx = await market.getLiquidateObligationInstruction(
    obligation,
    repayReserve,
    collateralReserve,
    p.liquidator.publicKey.toBase58() as Address
  );
  
  if (!liquidateIx) {
    throw new Error('Failed to build liquidation instruction from Kamino SDK');
  }
  
  // Convert SDK instruction to web3.js TransactionInstruction
  const convertedIx = new TransactionInstruction({
    programId: new PublicKey(liquidateIx.programAddress),
    keys: (liquidateIx.accounts || []).map(a => ({
      pubkey: new PublicKey(a.address),
      isSigner: a.role === 4 || a.role === 5, // READONLY_SIGNER=4, WRITABLE_SIGNER=5
      isWritable: a.role === 2 || a.role === 5, // WRITABLE=2, WRITABLE_SIGNER=5
    })),
    data: Buffer.from(liquidateIx.data || []),
  });
  
  return {
    ixs: [convertedIx],
  };
}
