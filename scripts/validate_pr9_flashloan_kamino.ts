/**
 * PR9 Flashloan Validator
 * 
 * Validates that Kamino flashloan dry-run works correctly:
 * - Transaction simulation succeeds
 * - Logs contain expected program invocations (borrow/repay)
 * - Compute units consumed is reported
 * - No missing accounts or wrong PDA issues
 * - Fee buffer precheck is enforced
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import fs from "node:fs";
import { Buffer } from "node:buffer";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { loadEnv } from "../src/config/env.js";
import { buildKaminoFlashloanIxs, type FlashloanMint } from "../src/flashloan/kaminoFlashloan.js";
import { buildComputeBudgetIxs } from "../src/execution/computeBudget.js";
import { MEMO_PROGRAM_ID } from "../src/constants/programs.js";
import { SOL_MINT, USDC_MINT } from "../src/constants/mints.js";

/**
 * Helper function to get token balance in UI units
 */
async function getTokenUiBalance(connection: Connection, ata: PublicKey): Promise<number> {
  try {
    const balance = await connection.getTokenAccountBalance(ata);
    return parseFloat(balance.value.uiAmountString || "0");
  } catch {
    // If ATA doesn't exist yet, return 0
    return 0;
  }
}

function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("Keypair file must be a JSON array");
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function createPlaceholderInstruction(signer: PublicKey): TransactionInstruction {
  const message = "PR9 flashloan placeholder";
  
  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(message, "utf8"),
  });
}

async function validateFlashloan(mint: FlashloanMint, amount: string, requiredFeeBufferUi?: number) {
  console.log(`\nValidating ${mint} flashloan (${amount})...`);
  
  // Use default fee buffer if not provided: USDC → 1.0, SOL → 0.01
  const feeBuffer = requiredFeeBufferUi !== undefined ? requiredFeeBufferUi : (mint === "SOL" ? 0.01 : 1.0);
  
  // Load environment
  const env = loadEnv();
  
  // Setup connection and signer
  const connection = new Connection(env.RPC_PRIMARY, "confirmed");
  const signer = loadKeypair(env.BOT_KEYPAIR_PATH);

  // Preflight: payer must exist on-chain and have lamports
  const payerInfo = await connection.getAccountInfo(signer.publicKey);
  if (!payerInfo) {
    throw new Error(
      `Fee payer account ${signer.publicKey.toBase58()} does not exist on-chain yet. ` +
      `Send some SOL to this address (e.g. 0.05 SOL) then retry.`
    );
  }

  if (payerInfo.lamports === 0) {
    throw new Error(
      `Fee payer account ${signer.publicKey.toBase58()} has 0 lamports. ` +
      `Fund it with SOL for transaction fees then retry.`
    );
  }

  // Build compute budget instructions
  const computeBudgetIxs = buildComputeBudgetIxs({ cuLimit: 600_000, cuPriceMicroLamports: 0 });
  
  // Pass 1: Build flashloan assuming no preIxs
  let borrowIxIndex = computeBudgetIxs.length;
  
  let built = await buildKaminoFlashloanIxs({
    connection,
    marketPubkey: new PublicKey(env.KAMINO_MARKET_PUBKEY),
    programId: new PublicKey(env.KAMINO_KLEND_PROGRAM_ID),
    signer,
    mint,
    amountUi: amount,
    borrowIxIndex,
  });

  // Idempotent ATA create if missing
  const preIxs: TransactionInstruction[] = [];
  const ataInfo = await connection.getAccountInfo(built.destinationAta);
  
  if (!ataInfo) {
    // Determine mint pubkey based on mint type
    let mintPubkey: PublicKey;
    if (mint === "USDC") {
      mintPubkey = new PublicKey(USDC_MINT);
    } else if (mint === "SOL") {
      mintPubkey = new PublicKey(SOL_MINT);
    } else {
      // This should never happen due to type checking, but guard against it
      throw new Error(`Unsupported mint type: ${mint}`);
    }
    
    preIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,               // payer
        built.destinationAta,           // ATA address
        signer.publicKey,               // owner
        mintPubkey,                     // mint
        built.tokenProgramId,           // token program (Token or Token-2022) from SDK
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    // Pass 2: recompute borrowIxIndex and rebuild flashloan with correct index
    borrowIxIndex = computeBudgetIxs.length + preIxs.length;
    
    built = await buildKaminoFlashloanIxs({
      connection,
      marketPubkey: new PublicKey(env.KAMINO_MARKET_PUBKEY),
      programId: new PublicKey(env.KAMINO_KLEND_PROGRAM_ID),
      signer,
      mint,
      amountUi: amount,
      borrowIxIndex,
    });
  }

  const { destinationAta, flashBorrowIx, flashRepayIx } = built;

  // Fee buffer precheck: ensure destination ATA has sufficient balance
  const currentUi = await getTokenUiBalance(connection, destinationAta);
  
  if (currentUi < feeBuffer) {
    const mintName = mint === "SOL" ? "SOL (wrapped SOL)" : mint;
    const shortfall = feeBuffer - currentUi;
    
    throw new Error(
      `Insufficient fee buffer in destination ATA.\n` +
      `  Destination ATA: ${destinationAta.toBase58()}\n` +
      `  Mint: ${mintName}\n` +
      `  Current balance: ${currentUi} ${mint}\n` +
      `  Required buffer: ${feeBuffer} ${mint}\n` +
      `  Shortfall: ${shortfall} ${mint}\n\n` +
      `Action required: Transfer at least ${feeBuffer} ${mint} to the destination ATA before running this validator.\n` +
      `You can override the default buffer with --fee-buffer-ui <amount>.`
    );
  }

  // Create placeholder instruction
  const placeholderIx = createPlaceholderInstruction(signer.publicKey);

  // Build transaction with correct instruction order:
  // 1. Compute budget instructions
  // 2. Pre-instructions (ATA creation if needed)
  // 3. Flash borrow (at borrowIxIndex)
  // 4. Placeholder (where liquidation + swap would go)
  // 5. Flash repay
  const transaction = new Transaction();
  transaction.add(...computeBudgetIxs);
  transaction.add(...preIxs);              // ensure ATA exists before borrow
  transaction.add(flashBorrowIx);
  transaction.add(placeholderIx);
  transaction.add(flashRepayIx);

  // Set recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = signer.publicKey;

  // Preflight: check all accounts exist before simulation
  function collectTxPubkeys(ixs: TransactionInstruction[]): PublicKey[] {
    const map = new Map<string, PublicKey>();
    for (const ix of ixs) {
      map.set(ix.programId.toBase58(), ix.programId);
      for (const k of ix.keys) map.set(k.pubkey.toBase58(), k.pubkey);
    }
    return [...map.values()];
  }

  const allKeys = collectTxPubkeys(transaction.instructions);
  const infos = await connection.getMultipleAccountsInfo(allKeys);

  // Build ignored set: Instructions Sysvar + destination ATA if created in-tx
  const ignored = new Set<string>();
  ignored.add(SYSVAR_INSTRUCTIONS_PUBKEY.toBase58());
  if (preIxs.length > 0) {
    ignored.add(destinationAta.toBase58());
  }

  const missing = allKeys
    .map((k, i) => ({ k, info: infos[i] }))
    .filter((x) => x.info === null && !ignored.has(x.k.toBase58()))
    .map((x) => x.k.toBase58());

  if (missing.length) {
    throw new Error(
      `Preflight failed: missing ${missing.length} account(s). First missing: ${missing[0]}`
    );
  }

  // Simulate transaction
  const simulation = await connection.simulateTransaction(transaction, [signer]);

  // Check for simulation errors
  if (simulation.value.err) {
    throw new Error(
      `Simulation failed for ${mint}: ${JSON.stringify(simulation.value.err)}\n` +
      `Logs: ${simulation.value.logs?.join("\n")}`
    );
  }

  const unitsConsumed = simulation.value.unitsConsumed;
  const logs = simulation.value.logs || [];

  // Validate compute units consumed is present
  if (!unitsConsumed || unitsConsumed === 0) {
    throw new Error(`Compute units consumed missing or zero for ${mint}`);
  }

  // Validate logs contain expected invocations
  const hasBorrow = logs.some((log) => 
    log.toLowerCase().includes("borrow") || 
    log.includes("FlashBorrow")
  );
  const hasRepay = logs.some((log) => 
    log.toLowerCase().includes("repay") || 
    log.includes("FlashRepay")
  );

  if (!hasBorrow) {
    throw new Error(`Expected borrow invocation not found in logs for ${mint}`);
  }
  if (!hasRepay) {
    throw new Error(`Expected repay invocation not found in logs for ${mint}`);
  }

  console.log(`✓ ${mint} simulation succeeded`);
  console.log(`  Compute units: ${unitsConsumed}`);
  console.log(`  Instructions: ${transaction.instructions.length}`);
  console.log(`  Destination ATA: ${destinationAta.toBase58()}`);
  console.log(`  Borrow invocation: found`);
  console.log(`  Repay invocation: found`);
}

async function main() {
  console.log("PR9 Kamino Flashloan Validator");
  console.log("==============================\n");

  // Parse command line args
  const args = process.argv.slice(2);
  const feeBufferArg = args.find((_arg, i) => args[i - 1] === "--fee-buffer-ui");
  
  let feeBufferUi: number | undefined;
  if (feeBufferArg) {
    feeBufferUi = parseFloat(feeBufferArg);
    if (isNaN(feeBufferUi) || feeBufferUi < 0) {
      throw new Error(`Invalid --fee-buffer-ui: ${feeBufferArg}. Must be a non-negative number.`);
    }
    console.log(`Using custom fee buffer: ${feeBufferUi}\n`);
  }

  try {
    // Test both SOL and USDC flashloans
    await validateFlashloan("USDC", "1000", feeBufferUi);
    await validateFlashloan("SOL", "10", feeBufferUi);

    console.log("\n✅ PR9 flashloan validation passed!");
  } catch (err) {
    console.error("\n❌ Validation failed:");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n❌ Unexpected error:");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
