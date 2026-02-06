import { Connection, PublicKey, TransactionInstruction, Keypair } from "@solana/web3.js";
import { KaminoMarket } from "@kamino-finance/klend-sdk";
import { getAssociatedTokenAddress } from "@kamino-finance/klend-sdk";
import { getFlashLoanInstructions } from "@kamino-finance/klend-sdk";
import { Decimal } from "decimal.js";

// @solana/kit account role constants for instruction conversion
const ACCOUNT_ROLE_WRITABLE = 1;
const ACCOUNT_ROLE_SIGNER = 2;
const ACCOUNT_ROLE_WRITABLE_SIGNER = 3;

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
  flashBorrowIx: TransactionInstruction;
  flashRepayIx: TransactionInstruction;
}

/**
 * Convert SDK instruction account to web3.js AccountMeta
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertSdkAccount(a: any) {
  return {
    pubkey: new PublicKey(a.address),
    isSigner: a.role === ACCOUNT_ROLE_SIGNER || a.role === ACCOUNT_ROLE_WRITABLE_SIGNER,
    isWritable: a.role === ACCOUNT_ROLE_WRITABLE || a.role === ACCOUNT_ROLE_WRITABLE_SIGNER,
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
  // Load market from Kamino SDK
  // Note: SDK v7.3.9 requires recentSlotDurationMs parameter
  const market = await KaminoMarket.load(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.connection as any, // Cast to handle web3.js v1 vs @solana/kit compatibility
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.marketPubkey.toBase58() as any, // SDK uses Address (branded string) type
    1000, // recentSlotDurationMs - default value
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.programId.toBase58() as any // SDK uses Address (branded string) type
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

  // Convert UI amount to lamports
  const amountDecimal = new Decimal(p.amountUi);
  const lamportsDecimal = amountDecimal.mul(new Decimal(10).pow(decimals));

  // Derive user ATA for the reserve
  // SDK's getAssociatedTokenAddress handles token program automatically
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const destinationAtaStr = await getAssociatedTokenAddress(
    reserveMint,
    p.signer.publicKey.toBase58() as any
  );
  const destinationAta = new PublicKey(destinationAtaStr);

  // Get lending market authority
  const lendingMarketAuthority = await market.getLendingMarketAuthority();

  // Build flashloan instructions using SDK helper
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { flashBorrowIx, flashRepayIx } = getFlashLoanInstructions({
    borrowIxIndex: p.borrowIxIndex,
    userTransferAuthority: p.signer.publicKey.toBase58() as any, // SDK expects TransactionSigner
    lendingMarketAuthority,
    lendingMarketAddress: market.getAddress(),
    reserve,
    amountLamports: lamportsDecimal,
    destinationAta: destinationAtaStr as any,
    referrerAccount: null as any, // No referrer for flashloans
    referrerTokenState: null as any,
    programId: p.programId.toBase58() as any,
  });

  // Convert SDK instructions to web3.js TransactionInstruction
  const borrowIx = new TransactionInstruction({
    keys: (flashBorrowIx.accounts || []).map(convertSdkAccount),
    programId: new PublicKey(flashBorrowIx.programAddress),
    data: Buffer.from(flashBorrowIx.data || []),
  });

  const repayIx = new TransactionInstruction({
    keys: (flashRepayIx.accounts || []).map(convertSdkAccount),
    programId: new PublicKey(flashRepayIx.programAddress),
    data: Buffer.from(flashRepayIx.data || []),
  });

  return {
    destinationAta,
    flashBorrowIx: borrowIx,
    flashRepayIx: repayIx,
  };
}
