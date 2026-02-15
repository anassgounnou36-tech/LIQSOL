import { 
  Connection, 
  PublicKey, 
  TransactionInstruction, 
  Keypair,
  VersionedTransaction,
  TransactionMessage
} from "@solana/web3.js";
import { buildComputeBudgetIxs } from "../execution/computeBudget.js";
import { buildKaminoFlashloanIxs } from "../flashloan/kaminoFlashloan.js";
import { buildKaminoLiquidationIxs } from "./liquidationBuilder.js";

/**
 * Canonical liquidation instruction sequence configuration
 */
export interface CanonicalLiquidationConfig {
  connection: Connection;
  signer: Keypair;
  
  // Market and program
  marketPubkey: PublicKey;
  programId: PublicKey;
  
  // Obligation details
  obligationPubkey: PublicKey;
  
  // Compute budget
  cuLimit: number;
  cuPrice: number;
  
  // Flashloan parameters (optional - if not provided, no flashloan will be used)
  flashloan?: {
    mint: string;
    amountUi: string;
  };
  
  // Liquidation parameters
  repayMintPreference?: PublicKey;
  repayAmountUi?: string;
  expectedRepayReservePubkey?: PublicKey;
  expectedCollateralReservePubkey?: PublicKey;
  
  // Swap parameters (optional - if not provided, no swap will be used)
  swap?: {
    instructions: TransactionInstruction[];
  };
}

/**
 * Canonical liquidation result with all instruction sequences
 */
export interface CanonicalLiquidationResult {
  // Setup instructions (ATA creation) - should be sent in separate transaction
  setupIxs: TransactionInstruction[];
  setupLabels: string[];
  
  // Main liquidation instruction sequence
  instructions: TransactionInstruction[];
  labels: string[];
  
  // Metadata
  repayMint: PublicKey;
  collateralMint: PublicKey;
  withdrawCollateralMint: PublicKey;
  hasFarmsRefresh: boolean;
}

/**
 * Build canonical liquidation instruction sequence used by ALL paths.
 * 
 * This is the SINGLE SOURCE OF TRUTH for liquidation instruction assembly.
 * 
 * Canonical order (with flashloan):
 * 1. computeBudget (limit + optional price)
 * 2. flashBorrow (if using flashloan)
 * 3. preRefreshReserve(repay)
 * 4. preRefreshReserve(collateral)
 * 5. refreshFarmsForObligationForReserve (collateral, if farm exists)
 * 6. refreshObligation (with remaining accounts ordered deposits→borrows)
 * 7. postRefreshReserve(repay)
 * 8. postRefreshReserve(collateral)
 * 9. liquidateObligationAndRedeemReserveCollateral
 * 10. swap instructions (if provided and executed AFTER liquidate)
 * 11. flashRepay (if using flashloan)
 * 
 * @param config - Canonical configuration with all parameters
 * @returns Canonical instruction sequence with labels
 */
export async function buildKaminoRefreshAndLiquidateIxsCanonical(
  config: CanonicalLiquidationConfig
): Promise<CanonicalLiquidationResult> {
  const instructions: TransactionInstruction[] = [];
  const labels: string[] = [];
  
  // 1. ComputeBudget instructions (always included)
  const computeIxs = buildComputeBudgetIxs({
    cuLimit: config.cuLimit,
    cuPriceMicroLamports: config.cuPrice,
  });
  instructions.push(...computeIxs);
  labels.push('computeBudget:limit');
  if (computeIxs.length > 1) {
    labels.push('computeBudget:price');
  }
  
  // 2. FlashBorrow (optional)
  let flashBorrowIx: TransactionInstruction | undefined;
  let flashRepayIx: TransactionInstruction | undefined;
  
  if (config.flashloan) {
    const borrowIxIndex = instructions.length;
    const flashloanResult = await buildKaminoFlashloanIxs({
      connection: config.connection,
      marketPubkey: config.marketPubkey,
      programId: config.programId,
      signer: config.signer,
      mint: config.flashloan.mint,
      amountUi: config.flashloan.amountUi,
      borrowIxIndex,
    });
    
    flashBorrowIx = flashloanResult.flashBorrowIx;
    flashRepayIx = flashloanResult.flashRepayIx;
    
    instructions.push(flashBorrowIx);
    labels.push('flashBorrow');
  }
  
  // 3-9. Build liquidation instructions (pre-refresh + refresh + post-refresh + liquidate)
  const liquidationResult = await buildKaminoLiquidationIxs({
    connection: config.connection,
    marketPubkey: config.marketPubkey,
    programId: config.programId,
    obligationPubkey: config.obligationPubkey,
    liquidatorPubkey: config.signer.publicKey,
    repayMintPreference: config.repayMintPreference,
    repayAmountUi: config.repayAmountUi,
    expectedRepayReservePubkey: config.expectedRepayReservePubkey,
    expectedCollateralReservePubkey: config.expectedCollateralReservePubkey,
  });
  
  // Extract setup instructions (should be sent separately)
  const setupIxs = liquidationResult.setupIxs;
  const setupLabels = liquidationResult.setupAtaNames.map(name => `setup:ata:${name}`);
  
  // 3-4. PRE-REFRESH instructions
  instructions.push(...liquidationResult.preRefreshIxs);
  labels.push('preRefreshReserve:repay');
  labels.push('preRefreshReserve:collateral');
  
  // 5-6. CORE REFRESH instructions (farms + obligation)
  instructions.push(...liquidationResult.refreshIxs);
  if (liquidationResult.hasFarmsRefresh) {
    labels.push('refreshFarms');
  }
  labels.push('refreshObligation');
  
  // 7-8. POST-REFRESH instructions
  instructions.push(...liquidationResult.postRefreshIxs);
  labels.push('postRefreshReserve:repay');
  labels.push('postRefreshReserve:collateral');
  
  // 9. LIQUIDATE instruction
  instructions.push(...liquidationResult.liquidationIxs);
  labels.push('liquidate');
  
  // 10. Swap instructions (optional, after liquidate)
  if (config.swap && config.swap.instructions.length > 0) {
    instructions.push(...config.swap.instructions);
    for (let i = 0; i < config.swap.instructions.length; i++) {
      labels.push(`swap:${i}`);
    }
  }
  
  // 11. FlashRepay (optional)
  if (flashRepayIx) {
    instructions.push(flashRepayIx);
    labels.push('flashRepay');
  }
  
  return {
    setupIxs,
    setupLabels,
    instructions,
    labels,
    repayMint: liquidationResult.repayMint,
    collateralMint: liquidationResult.collateralMint,
    withdrawCollateralMint: liquidationResult.withdrawCollateralMint,
    hasFarmsRefresh: liquidationResult.hasFarmsRefresh,
  };
}

/**
 * Instruction kind for validation
 */
interface InstructionKind {
  programId: string;
  discriminator?: string; // First 8 bytes of instruction data as hex
  kind: string; // Human-readable kind
}

/**
 * Decode instruction kinds from compiled transaction message.
 * 
 * Extracts program ID and instruction discriminator (first 8 bytes of data)
 * to identify instruction types in the compiled message.
 * 
 * @param tx - Compiled versioned transaction
 * @returns Array of instruction kinds in message order
 */
export function decodeCompiledInstructionKinds(tx: VersionedTransaction): InstructionKind[] {
  const message = tx.message;
  const instructions = message.compiledInstructions;
  const accountKeys = message.staticAccountKeys;
  
  return instructions.map((ix, idx) => {
    const programIdKey = accountKeys[ix.programIdIndex];
    const programId = programIdKey.toBase58();
    
    // Extract first 8 bytes of data as discriminator (if available)
    let discriminator: string | undefined;
    if (ix.data.length >= 8) {
      discriminator = Buffer.from(ix.data.slice(0, 8)).toString('hex');
    }
    
    // Map known program IDs to human-readable names
    let kind = 'unknown';
    
    // Kamino KLend program
    if (programId === 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD') {
      // Decode Kamino instruction discriminators
      // These are anchor discriminators: first 8 bytes of sha256("global:instruction_name")
      if (discriminator === '07930aa66d3aa710') kind = 'refreshReserve';
      else if (discriminator === 'a8e5e45f8c4c29c0') kind = 'refreshObligation';
      else if (discriminator === 'd88378ff5e9e5028') kind = 'liquidateObligationAndRedeemReserveCollateral';
      else if (discriminator === 'd79cf84dbd8fe9e2') kind = 'refreshObligationFarmsForReserve';
      else if (discriminator === 'd60e1307b8c6ef35') kind = 'flashBorrowReserveLiquidity';
      else if (discriminator === 'f69c6e18b02e3e8d') kind = 'flashRepayReserveLiquidity';
      else kind = `kamino:${discriminator ?? 'unknown'}`;
    }
    // Compute Budget program
    else if (programId === 'ComputeBudget111111111111111111111111111111') {
      if (discriminator) {
        const firstByte = ix.data[0];
        if (firstByte === 0x02) kind = 'computeBudget:limit';
        else if (firstByte === 0x03) kind = 'computeBudget:price';
        else kind = 'computeBudget:unknown';
      } else {
        kind = 'computeBudget';
      }
    }
    // Jupiter V6 program
    else if (programId === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4') {
      kind = 'jupiter:swap';
    }
    // Token program
    else if (programId === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
      kind = 'token:instruction';
    }
    // Token-2022 program
    else if (programId === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') {
      kind = 'token2022:instruction';
    }
    // ATA program
    else if (programId === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL') {
      kind = 'ata:create';
    }
    
    return {
      programId,
      discriminator,
      kind,
    };
  });
}

/**
 * Validate compiled transaction instruction window.
 * 
 * After compiling to VersionedTransaction, verify that the instruction sequence
 * immediately before liquidation matches the expected canonical order.
 * 
 * Expected window before liquidation (last 4-5 instructions):
 * - refreshFarmsForObligationForReserve (optional, if farm exists)
 * - refreshObligation
 * - refreshReserve (repay)
 * - refreshReserve (collateral)
 * - liquidateObligationAndRedeemReserveCollateral
 * 
 * @param tx - Compiled versioned transaction
 * @param expectedLabels - Expected label sequence (from canonical builder)
 * @param hasFarmsRefresh - Whether farms refresh instruction should be present
 * @returns Validation result with detailed diagnostics
 */
export function validateCompiledInstructionWindow(
  tx: VersionedTransaction,
  expectedLabels: string[],
  hasFarmsRefresh: boolean
): { valid: boolean; diagnostics: string } {
  const kinds = decodeCompiledInstructionKinds(tx);
  
  // Find liquidation instruction
  const liquidateIdx = kinds.findIndex(k => k.kind === 'liquidateObligationAndRedeemReserveCollateral');
  
  if (liquidateIdx === -1) {
    return {
      valid: false,
      diagnostics: 'Liquidation instruction not found in compiled transaction',
    };
  }
  
  // Build expected sequence before liquidation
  const expectedSequence = hasFarmsRefresh
    ? ['refreshObligationFarmsForReserve', 'refreshObligation', 'refreshReserve', 'refreshReserve']
    : ['refreshObligation', 'refreshReserve', 'refreshReserve'];
  
  // Validate the sequence
  const startIdx = liquidateIdx - expectedSequence.length;
  if (startIdx < 0) {
    return {
      valid: false,
      diagnostics: `Not enough instructions before liquidation. Expected ${expectedSequence.length}, found ${liquidateIdx}`,
    };
  }
  
  // Extract actual sequence
  const actualSequence = kinds.slice(startIdx, liquidateIdx).map(k => k.kind);
  
  // Compare sequences
  const matches = expectedSequence.every((expected, idx) => actualSequence[idx] === expected);
  
  if (!matches) {
    let diagnostics = 'Compiled instruction window does not match expected sequence\n\n';
    diagnostics += 'Expected sequence before liquidation:\n';
    expectedSequence.forEach((kind, idx) => {
      diagnostics += `  [${startIdx + idx}] ${kind}\n`;
    });
    diagnostics += '\nActual sequence before liquidation:\n';
    actualSequence.forEach((kind, idx) => {
      diagnostics += `  [${startIdx + idx}] ${kind}\n`;
    });
    diagnostics += '\nFull instruction window (6-instruction window around liquidation):\n';
    const windowStart = Math.max(0, liquidateIdx - 5);
    const windowEnd = Math.min(kinds.length, liquidateIdx + 2);
    for (let i = windowStart; i < windowEnd; i++) {
      const marker = i === liquidateIdx ? ' ← liquidate' : '';
      diagnostics += `  [${i}] ${kinds[i].kind} (${kinds[i].programId.slice(0, 8)}...)${marker}\n`;
    }
    
    return { valid: false, diagnostics };
  }
  
  // Validation passed
  let diagnostics = '✓ Compiled instruction window validation passed\n\n';
  diagnostics += 'Validated 6-instruction window before liquidation:\n';
  const windowStart = Math.max(0, liquidateIdx - 5);
  for (let i = windowStart; i <= liquidateIdx; i++) {
    const marker = i === liquidateIdx ? ' ← liquidate' : '';
    diagnostics += `  [${i}] ${kinds[i].kind}${marker}\n`;
  }
  
  return { valid: true, diagnostics };
}

/**
 * Build and validate canonical liquidation transaction.
 * 
 * This helper:
 * 1. Builds canonical instruction sequence
 * 2. Compiles to VersionedTransaction
 * 3. Validates compiled instruction window
 * 4. Returns signed transaction with validation diagnostics
 * 
 * @param config - Canonical configuration
 * @returns Validated transaction with diagnostics
 */
export async function buildAndValidateCanonicalLiquidationTx(
  config: CanonicalLiquidationConfig
): Promise<{
  setupTx?: VersionedTransaction;
  setupLabels?: string[];
  tx: VersionedTransaction;
  labels: string[];
  validation: { valid: boolean; diagnostics: string };
  metadata: {
    repayMint: PublicKey;
    collateralMint: PublicKey;
    withdrawCollateralMint: PublicKey;
    hasFarmsRefresh: boolean;
  };
}> {
  // Build canonical instructions
  const canonical = await buildKaminoRefreshAndLiquidateIxsCanonical(config);
  
  // Build setup transaction if needed
  let setupTx: VersionedTransaction | undefined;
  if (canonical.setupIxs.length > 0) {
    const setupBh = await config.connection.getLatestBlockhash();
    const setupMsg = new TransactionMessage({
      payerKey: config.signer.publicKey,
      recentBlockhash: setupBh.blockhash,
      instructions: canonical.setupIxs,
    });
    const setupCompiledMsg = setupMsg.compileToLegacyMessage();
    setupTx = new VersionedTransaction(setupCompiledMsg);
    setupTx.sign([config.signer]);
  }
  
  // Build main liquidation transaction
  const bh = await config.connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: config.signer.publicKey,
    recentBlockhash: bh.blockhash,
    instructions: canonical.instructions,
  });
  const compiledMsg = msg.compileToLegacyMessage();
  const tx = new VersionedTransaction(compiledMsg);
  tx.sign([config.signer]);
  
  // Validate compiled instruction window
  const validation = validateCompiledInstructionWindow(
    tx,
    canonical.labels,
    canonical.hasFarmsRefresh
  );
  
  return {
    setupTx,
    setupLabels: canonical.setupLabels.length > 0 ? canonical.setupLabels : undefined,
    tx,
    labels: canonical.labels,
    validation,
    metadata: {
      repayMint: canonical.repayMint,
      collateralMint: canonical.collateralMint,
      withdrawCollateralMint: canonical.withdrawCollateralMint,
      hasFarmsRefresh: canonical.hasFarmsRefresh,
    },
  };
}
