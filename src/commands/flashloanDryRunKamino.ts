import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import fs from "node:fs";
import { Buffer } from "node:buffer";
import { loadEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { buildKaminoFlashloanIxs, type FlashloanMint } from "../flashloan/kaminoFlashloan.js";
import { buildComputeBudgetIxs } from "../execution/computeBudget.js";
import { MEMO_PROGRAM_ID } from "../constants/programs.js";

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

async function main() {
  // Parse command line args
  const args = process.argv.slice(2);
  const mintArg = args.find((_arg, i) => args[i - 1] === "--mint")?.toUpperCase();
  const amountArg = args.find((_arg, i) => args[i - 1] === "--amount");

  const mint = (mintArg || "USDC") as FlashloanMint;
  const amount = amountArg || "1000";

  // Validate mint
  if (mint !== "SOL" && mint !== "USDC") {
    throw new Error(`Invalid mint: ${mint}. Must be SOL or USDC`);
  }

  logger.info(
    { event: "flashloan_dryrun_start", mint, amount },
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

  // Build compute budget instructions
  const computeBudgetIxs = buildComputeBudgetIxs({ cuLimit: 600_000, cuPriceMicroLamports: 0 });
  
  logger.info(
    { event: "compute_budget_built", count: computeBudgetIxs.length },
    "Compute budget instructions built"
  );

  // Build flashloan instructions
  // borrowIxIndex will be the position after compute budget ixs
  const borrowIxIndex = computeBudgetIxs.length;
  
  logger.info(
    { event: "building_flashloan", borrowIxIndex, mint, amount },
    "Building flashloan instructions"
  );

  const { destinationAta, tokenProgramId, flashBorrowIx, flashRepayIx } = await buildKaminoFlashloanIxs({
    connection,
    marketPubkey: new PublicKey(env.KAMINO_MARKET_PUBKEY),
    programId: new PublicKey(env.KAMINO_KLEND_PROGRAM_ID),
    signer,
    mint,
    amountUi: amount,
    borrowIxIndex,
  });

  logger.info(
    { 
      event: "flashloan_built", 
      destinationAta: destinationAta.toBase58(),
      tokenProgramId: tokenProgramId.toBase58()
    },
    "Flashloan instructions built"
  );

  // Debug prints for ATA and token program
  console.log("Destination ATA:", destinationAta.toBase58());
  console.log("Token program:", tokenProgramId.toBase58());

  // Create placeholder instruction
  const placeholderIx = createPlaceholderInstruction(signer.publicKey);

  // Build transaction with correct instruction order:
  // 1. Compute budget instructions
  // 2. Flash borrow (at borrowIxIndex)
  // 3. Placeholder (where liquidation + swap would go)
  // 4. Flash repay
  const transaction = new Transaction();
  transaction.add(...computeBudgetIxs);
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

  console.log({ invokeCount }, "Kamino flashloan dry-run log summary");
}

main().catch((err) => {
  logger.fatal({ event: "flashloan_dryrun_failed", err }, "Flashloan dry-run failed");
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
