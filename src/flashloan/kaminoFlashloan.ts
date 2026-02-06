import { Connection, PublicKey, TransactionInstruction, Keypair, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { Buffer } from "node:buffer";
import { KaminoMarket } from "@kamino-finance/klend-sdk";
import { getAssociatedTokenAddress } from "@kamino-finance/klend-sdk";
import { getFlashLoanInstructions } from "@kamino-finance/klend-sdk";
import { Decimal } from "decimal.js";
import { createKeyPairSignerFromBytes } from "@solana/signers";
import { AccountRole } from "@solana/instructions";
import { createSolanaRpc } from "@solana/rpc";
import type { Address } from "@solana/addresses";
import { none } from "@solana/options";

export type FlashloanMint = "USDC" | "SOL";

export interface BuildKaminoFlashloanParams {
  connection: Connection;
  marketPubkey: PublicKey;
  programId: PublicKey; // from env.KAMINO_KLEND_PROGRAM_ID

  signer: Keypair;      // userTransferAuthority + fee payer
  mint: FlashloanMint;
  amountUi: string;     // e.g. "1000" USDC, "10" SOL

  borrowIxIndex: number; // in PR9 dry-run: 0
}

export interface KaminoFlashloanIxs {
  destinationAta: PublicKey;
  tokenProgramId: PublicKey;
  flashBorrowIx: TransactionInstruction;
  flashRepayIx: TransactionInstruction;
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
 * Build Kamino flashloan instructions (borrow + repay) using SDK.
 * 
 * This uses the Kamino SDK's KaminoMarket.load() to fetch reserve data,
 * then calls getFlashLoanInstructions() to build the instruction pair.
 * 
 * The borrowIxIndex parameter must match the position of flashBorrowIx
 * in the final transaction (Kamino validates repayment relative to this index).
 * 
 * @param p - Flashloan parameters including market, signer, mint, and amount
 * @returns Object containing destination ATA, borrow instruction, and repay instruction
 */
export async function buildKaminoFlashloanIxs(p: BuildKaminoFlashloanParams): Promise<KaminoFlashloanIxs> {
  // Create @solana/kit RPC from connection URL for Kamino SDK compatibility
  // The SDK v7.3.9 requires @solana/kit Rpc, not web3.js v1 Connection
  const rpc = createSolanaRpc(p.connection.rpcEndpoint);

  // Load market from Kamino SDK
  // Note: SDK v7.3.9 requires recentSlotDurationMs parameter
  // Note: Type cast needed due to @solana/kit v2 vs v3 incompatibility in SDK dependencies
  const market = await KaminoMarket.load(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc as any, // RPC type compatibility between @solana/kit v2 (SDK) and v3 (our imports)
    p.marketPubkey.toBase58() as Address,
    1000, // recentSlotDurationMs - default value
    p.programId.toBase58() as Address
  );

  if (!market) {
    throw new Error(`Failed to load market: ${p.marketPubkey.toBase58()}`);
  }

  // Get reserve by mint symbol
  let reserve;
  if (p.mint === "SOL") {
    reserve = market.getReserveBySymbol("SOL");
  } else if (p.mint === "USDC") {
    reserve = market.getReserveBySymbol("USDC");
  } else {
    throw new Error(`Unsupported mint: ${p.mint}`);
  }

  if (!reserve) {
    throw new Error(`Reserve not found for mint: ${p.mint}`);
  }

  // Get reserve mint and decimals
  const reserveMint = reserve.getLiquidityMint();
  const decimals = reserve.stats.decimals;

  // Get token program for the reserve (Token-2022 safe)
  const tokenProgramId = reserve.getLiquidityTokenProgram();

  // Convert UI amount to lamports
  const amountDecimal = new Decimal(p.amountUi);
  const lamportsDecimal = amountDecimal.mul(new Decimal(10).pow(decimals));

  // Derive user ATA for the reserve with correct token program
  const destinationAtaStr = await getAssociatedTokenAddress(
    reserveMint,
    p.signer.publicKey.toBase58() as Address,
    tokenProgramId // Use reserve's token program for Token-2022 compatibility
  );
  const destinationAta = new PublicKey(destinationAtaStr);

  // Get lending market authority
  const lendingMarketAuthority = await market.getLendingMarketAuthority();

  // Convert web3.js Keypair to @solana/kit KeyPairSigner
  const sdkSigner = await createKeyPairSignerFromBytes(p.signer.secretKey);

  // Build flashloan instructions using SDK helper
  const { flashBorrowIx, flashRepayIx } = getFlashLoanInstructions({
    borrowIxIndex: p.borrowIxIndex,
    userTransferAuthority: sdkSigner, // Use proper signer object, not base58 string
    lendingMarketAuthority,
    lendingMarketAddress: market.getAddress(),
    reserve,
    amountLamports: lamportsDecimal,
    destinationAta: destinationAtaStr,
    referrerAccount: none(), // No referrer for flashloans
    referrerTokenState: none(),
    programId: p.programId.toBase58() as Address,
  });

  // Convert SDK instructions to web3.js TransactionInstruction
  // Force-add Instructions Sysvar for Kamino's borrowIxIndex validation
  const borrowKeys = (flashBorrowIx.accounts || []).map(convertSdkAccount);
  if (!borrowKeys.some(k => k.pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY))) {
    borrowKeys.push({ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false });
  }
  const borrowIx = new TransactionInstruction({
    keys: borrowKeys,
    programId: new PublicKey(flashBorrowIx.programAddress),
    data: Buffer.from(flashBorrowIx.data || []),
  });

  const repayKeys = (flashRepayIx.accounts || []).map(convertSdkAccount);
  if (!repayKeys.some(k => k.pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY))) {
    repayKeys.push({ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false });
  }
  const repayIx = new TransactionInstruction({
    keys: repayKeys,
    programId: new PublicKey(flashRepayIx.programAddress),
    data: Buffer.from(flashRepayIx.data || []),
  });

  return {
    destinationAta,
    tokenProgramId: new PublicKey(tokenProgramId),
    flashBorrowIx: borrowIx,
    flashRepayIx: repayIx,
  };
}
