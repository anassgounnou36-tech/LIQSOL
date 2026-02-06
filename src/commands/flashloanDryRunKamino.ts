import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import fs from "node:fs";
import { Buffer } from "node:buffer";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { loadEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { buildKaminoFlashloanIxs, type FlashloanMint } from "../flashloan/kaminoFlashloan.js";
import { buildComputeBudgetIxs } from "../execution/computeBudget.js";
import { MEMO_PROGRAM_ID } from "../constants/programs.js";
import { SOL_MINT, USDC_MINT } from "../constants/mints.js";

function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("Keypair file must be a JSON array");
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function createPlaceholderInstruction(signer: PublicKey): TransactionInstruction {
  // Create a simple memo instruction as placeholder
  // This simulates where liquidation + swap instructions would go
  const message = "PR9 flashloan placeholder";
  
  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(message, "utf8"),
  });
}

/**
 * Helper function to fetch token UI balance for an ATA
 */
async function getTokenBalance(connection: Connection, ata: PublicKey): Promise<number> {
  try {
    const balance = await connection.getTokenAccountBalance(ata);
    return parseFloat(balance.value.uiAmountString || "0");
  } catch (err) {
    // If account doesn't exist, return 0
    return 0;
  }
}

async function main() {
  // Parse command line args
  const args = process.argv.slice(2);
  const mintArg = args.find((_arg, i) => args[i - 1] === "--mint")?.toUpperCase();
  const amountArg = args.find((_arg, i) => args[i - 1] === "--amount");
  const feeBufferArg = args.find((_arg, i) => args[i - 1] === "--fee-buffer-ui");

  const mint = (mintArg || "USDC") as FlashloanMint;
  const amount = amountArg || "1000";
  // Default fee buffer: 0.3% (Kamino flashloan fee) + small margin = 0.5% of borrowed amount
  // User can override with --fee-buffer-ui
  const defaultFeeBuffer = parseFloat(amount) * 0.005;
  const feeBufferUi = feeBufferArg ? parseFloat(feeBufferArg) : defaultFeeBuffer;

  // Validate mint
  if (mint !== "SOL" && mint !== "USDC") {
    throw new Error(`Invalid mint: ${mint}. Must be SOL or USDC`);
  }

  logger.info(
    { event: "flashloan_dryrun_start", mint, amount, feeBufferUi },
    "Starting Kamino flashloan dry-run"
  );

  // Load environment
  const env = loadEnv();
  
  // Setup connection and signer
  const connection = new Connection(env.RPC_PRIMARY, "confirmed");
  const signer = loadKeypair(env.BOT_KEYPAIR_PATH);
  
  logger.info(
    { event: "config_loaded", signer: signer.publicKey.toBase58(), rpc: env.RPC_PRIMARY },
    "Configuration loaded"
  );

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
  
  logger.info(
    { event: "compute_budget_built", count: computeBudgetIxs.length },
    "Compute budget instructions built"
  );

  // Pass 1: Build flashloan assuming no preIxs
  let borrowIxIndex = computeBudgetIxs.length;
  
  logger.info(
    { event: "building_flashloan_pass1", borrowIxIndex, mint, amount },
    "Building flashloan instructions (pass 1)"
  );

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
    logger.info(
      { event: "ata_missing", ata: built.destinationAta.toBase58() },
      "Destination ATA does not exist, creating idempotent instruction"
    );
    
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
    
    logger.info(
      { event: "building_flashloan_pass2", borrowIxIndex },
      "Rebuilding flashloan with adjusted borrowIxIndex (pass 2)"
    );
    
    built = await buildKaminoFlashloanIxs({
      connection,
      marketPubkey: new PublicKey(env.KAMINO_MARKET_PUBKEY),
      programId: new PublicKey(env.KAMINO_KLEND_PROGRAM_ID),
      signer,
      mint,
      amountUi: amount,
      borrowIxIndex,
    });
  } else {
    logger.info(
      { event: "ata_exists", ata: built.destinationAta.toBase58() },
      "Destination ATA already exists"
    );
  }

  const { destinationAta, tokenProgramId, flashBorrowIx, flashRepayIx } = built;

  logger.info(
    { 
      event: "flashloan_built", 
      destinationAta: destinationAta.toBase58(),
      tokenProgramId: tokenProgramId.toBase58(),
      preIxsCount: preIxs.length
    },
    "Flashloan instructions built"
  );

  // Fee buffer precheck: Ensure destination ATA has enough balance to cover flashloan fee
  logger.info(
    { event: "checking_fee_buffer", ata: destinationAta.toBase58(), requiredFeeBuffer: feeBufferUi },
    "Checking fee buffer in destination ATA"
  );

  const currentBalance = await getTokenBalance(connection, destinationAta);

  logger.info(
    { event: "ata_balance_fetched", currentBalance, requiredFeeBuffer: feeBufferUi },
    "Current ATA balance fetched"
  );

  if (currentBalance < feeBufferUi) {
    const shortfall = feeBufferUi - currentBalance;
    logger.error(
      { 
        event: "insufficient_fee_buffer", 
        currentBalance, 
        requiredFeeBuffer: feeBufferUi,
        shortfall,
        mint
      },
      "Insufficient fee buffer in destination ATA"
    );

    throw new Error(
      `Insufficient fee buffer in destination ATA.\n` +
      `\n` +
      `Flashloan repay will fail with "insufficient funds" because the ATA does not hold enough ${mint} to cover the flashloan fee.\n` +
      `\n` +
      `Current balance: ${currentBalance} ${mint}\n` +
      `Required fee buffer: ${feeBufferUi} ${mint}\n` +
      `Shortfall: ${shortfall} ${mint}\n` +
      `\n` +
      `ACTION REQUIRED:\n` +
      `1. Transfer at least ${shortfall.toFixed(6)} ${mint} to the destination ATA: ${destinationAta.toBase58()}\n` +
      `2. Or specify a custom fee buffer with: --fee-buffer-ui <amount>\n` +
      `\n` +
      `Note: Kamino charges a 0.3% flashloan fee. The default fee buffer is 0.5% of the borrowed amount (${amount} ${mint}).\n` +
      `In a production liquidation, the swap would generate profit to cover this fee. For this dry-run, you must prefund the ATA.`
    );
  }

  logger.info(
    { event: "fee_buffer_check_passed", currentBalance, requiredFeeBuffer: feeBufferUi },
    "Fee buffer check passed"
  );

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

  logger.info(
    { event: "transaction_built", instructionCount: transaction.instructions.length },
    "Transaction built, simulating..."
  );

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

  const missing = allKeys
    .map((k, i) => ({ k, info: infos[i] }))
    .filter((x) => x.info === null)
    .map((x) => x.k.toBase58());

  if (missing.length) {
    logger.error(
      { event: "preflight_missing_accounts", missing, total: allKeys.length },
      "Some accounts referenced by the transaction do not exist on-chain"
    );

    throw new Error(
      `Preflight failed: missing ${missing.length} account(s). First missing: ${missing[0]}`
    );
  }

  // Simulate transaction
  const simulation = await connection.simulateTransaction(transaction, [signer]);

  if (simulation.value.err) {
    logger.error(
      { event: "simulation_failed", error: simulation.value.err, logs: simulation.value.logs },
      "Simulation failed"
    );
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  const unitsConsumed = simulation.value.unitsConsumed || 0;
  const logs = simulation.value.logs || [];

  logger.info(
    {
      event: "simulation_success",
      unitsConsumed,
      logsCount: logs.length,
    },
    "Simulation succeeded"
  );

  // Print summary
  console.log("\n✅ Flashloan Dry-Run Successful!");
  console.log(`   Mint: ${mint}`);
  console.log(`   Amount: ${amount}`);
  console.log(`   Compute Units Consumed: ${unitsConsumed}`);
  console.log(`   Instructions: ${transaction.instructions.length}`);
  console.log(`   Destination ATA: ${destinationAta.toBase58()}`);
  console.log(`   Token Program: ${tokenProgramId.toBase58()}`);
  console.log("\nSimulation Logs:");
  logs.forEach((log, i) => {
    console.log(`   [${i}] ${log}`);
  });

  // Validate logs contain expected Kamino program invocations (deterministic check)
  const kaminoProgramId = env.KAMINO_KLEND_PROGRAM_ID;
  const invokeCount = logs.filter((log) => log.includes(`Program ${kaminoProgramId} invoke`)).length;

  if (invokeCount < 2) {
    logger.warn(
      { event: "missing_invocations", invokeCount, expected: ">=2" },
      `Expected >=2 Kamino program invocations (borrow+repay), got ${invokeCount}`
    );
  } else {
    logger.info(
      { event: "invocations_verified", invokeCount },
      "Kamino flashloan invocations verified in logs"
    );
  }
}

main().catch((err) => {
  logger.fatal({ event: "flashloan_dryrun_failed", err }, "Flashloan dry-run failed");
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
