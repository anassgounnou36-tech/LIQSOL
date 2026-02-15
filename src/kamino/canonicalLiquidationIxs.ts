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
 * Canonical order (matching KLend's strict check_refresh adjacency rules):
 * 1. computeBudget (limit + optional price)
 * 2. flashBorrow (if using flashloan)
 * 
 * PRE BLOCK (contiguous):
 * 3. preRefreshReserve(collateral)
 * 4. preRefreshReserve(repay)
 * 5. refreshObligation (with remaining accounts ordered deposits→borrows)
 * 6. refreshFarmsForObligationForReserve (0-2 instructions for collateral/debt farms, if exist)
 * 
 * LIQUIDATE:
 * 7. liquidateObligationAndRedeemReserveCollateral
 * 
 * POST BLOCK (immediately after liquidation):
 * 8. refreshFarmsForObligationForReserve (same farm set and order as PRE, if exist)
 * 
 * 9. swap instructions (if provided, after POST farms)
 * 10. flashRepay (if using flashloan)
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
  
  // 3-8. Build liquidation instructions using new canonical arrays
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
  
  // 3-4. PRE-RESERVE instructions (collateral first, then repay)
  instructions.push(...liquidationResult.preReserveIxs);
  labels.push('preRefreshReserve:collateral');
  labels.push('preRefreshReserve:repay');
  
  // 5-6. CORE instructions (obligation + farms)
  instructions.push(...liquidationResult.coreIxs);
  labels.push('refreshObligation');
  // Add farm labels based on actual farm modes
  for (const mode of liquidationResult.farmModes) {
    const modeLabel = mode === 0 ? 'collateral' : 'debt';
    labels.push(`refreshFarms:${modeLabel}`);
  }
  
  // 7. LIQUIDATE instruction
  instructions.push(...liquidationResult.liquidationIxs);
  labels.push('liquidate');
  
  // 8. POST-FARM instructions (immediately after liquidation, mirrors PRE farms)
  instructions.push(...liquidationResult.postFarmIxs);
  for (const mode of liquidationResult.farmModes) {
    const modeLabel = mode === 0 ? 'collateral' : 'debt';
    labels.push(`postRefreshFarms:${modeLabel}`);
  }
  
  // 9. Swap instructions (optional, after POST farms)
  if (config.swap && config.swap.instructions.length > 0) {
    instructions.push(...config.swap.instructions);
    for (let i = 0; i < config.swap.instructions.length; i++) {
      labels.push(`swap:${i}`);
    }
  }
  
  // 10. FlashRepay (optional)
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
    hasFarmsRefresh: liquidationResult.farmRefreshCount > 0,
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
  
  return instructions.map((ix: any) => {
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
 * immediately before AND after liquidation matches KLend's strict check_refresh adjacency rules.
 * 
 * Expected canonical sequence:
 * PRE (contiguous, immediately before liquidation):
 * - refreshReserve (collateral)
 * - refreshReserve (repay)
 * - refreshObligation
 * - refreshFarmsForObligationForReserve (0-2 instructions for collateral/debt, if exist)
 * 
 * LIQUIDATE:
 * - liquidateObligationAndRedeemReserveCollateral
 * 
 * POST (immediately after liquidation):
 * - refreshFarmsForObligationForReserve (same farm set and order as PRE, if exist)
 * 
 * Key validation points:
 * 1. Last instruction before liquidation must be farms refresh (or obligation if no farms)
 * 2. First instruction after liquidation must be farms refresh (or nothing/swap if no farms)
 * 3. The 4 instructions before liquidation (or 2-3 if no farms) must match canonical PRE order
 * 
 * @param tx - Compiled versioned transaction
 * @param hasFarmsRefresh - Whether farms refresh instruction should be present
 * @returns Validation result with detailed diagnostics
 */
export function validateCompiledInstructionWindow(
  tx: VersionedTransaction,
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
  
  // Build expected sequence BEFORE liquidation
  // Order: reserves(collateral, repay) → obligation → farms (if exist)
  // NOTE: We look backwards from liquidation, so we read right-to-left in the array
  const expectedPreSequence = hasFarmsRefresh
    ? ['refreshReserve', 'refreshReserve', 'refreshObligation', 'refreshObligationFarmsForReserve']
    : ['refreshReserve', 'refreshReserve', 'refreshObligation'];
  
  // Validate PRE sequence
  const preStartIdx = liquidateIdx - expectedPreSequence.length;
  if (preStartIdx < 0) {
    return {
      valid: false,
      diagnostics: `Not enough instructions before liquidation. Expected ${expectedPreSequence.length}, found ${liquidateIdx}`,
    };
  }
  
  // Extract actual PRE sequence
  const actualPreSequence = kinds.slice(preStartIdx, liquidateIdx).map(k => k.kind);
  
  // Compare PRE sequences
  const preMatches = expectedPreSequence.every((expected, idx) => actualPreSequence[idx] === expected);
  
  if (!preMatches) {
    let diagnostics = 'Compiled PRE instruction window does not match expected sequence\n\n';
    diagnostics += 'Expected PRE sequence (immediately before liquidation):\n';
    expectedPreSequence.forEach((kind, idx) => {
      diagnostics += `  [${preStartIdx + idx}] ${kind}\n`;
    });
    diagnostics += '\nActual PRE sequence:\n';
    actualPreSequence.forEach((kind, idx) => {
      diagnostics += `  [${preStartIdx + idx}] ${kind}\n`;
    });
    diagnostics += '\nFull instruction window (9-instruction window around liquidation):\n';
    const windowStart = Math.max(0, liquidateIdx - 6);
    const windowEnd = Math.min(kinds.length, liquidateIdx + 3);
    for (let i = windowStart; i < windowEnd; i++) {
      const marker = i === liquidateIdx ? ' ← LIQUIDATE' : '';
      diagnostics += `  [${i}] ${kinds[i].kind} (${kinds[i].programId.slice(0, 8)}...)${marker}\n`;
    }
    
    return { valid: false, diagnostics };
  }
  
  // Validate POST sequence (farms refresh immediately after liquidation, if farms exist)
  if (hasFarmsRefresh) {
    const postIdx = liquidateIdx + 1;
    if (postIdx >= kinds.length) {
      return {
        valid: false,
        diagnostics: 'POST farms refresh expected but no instruction found after liquidation',
      };
    }
    
    const postKind = kinds[postIdx].kind;
    if (postKind !== 'refreshObligationFarmsForReserve') {
      let diagnostics = 'POST instruction after liquidation does not match expected farms refresh\n\n';
      diagnostics += `Expected: refreshObligationFarmsForReserve\n`;
      diagnostics += `Actual: ${postKind}\n`;
      diagnostics += '\nFull instruction window (9-instruction window around liquidation):\n';
      const windowStart = Math.max(0, liquidateIdx - 6);
      const windowEnd = Math.min(kinds.length, liquidateIdx + 3);
      for (let i = windowStart; i < windowEnd; i++) {
        const marker = i === liquidateIdx ? ' ← LIQUIDATE' : i === postIdx ? ' ← EXPECTED POST FARMS' : '';
        diagnostics += `  [${i}] ${kinds[i].kind} (${kinds[i].programId.slice(0, 8)}...)${marker}\n`;
      }
      
      return { valid: false, diagnostics };
    }
  }
  
  // Validation passed
  let diagnostics = '✓ Compiled instruction window validation passed\n\n';
  diagnostics += 'Validated canonical sequence around liquidation:\n\n';
  diagnostics += 'PRE (immediately before liquidation):\n';
  for (let i = preStartIdx; i < liquidateIdx; i++) {
    diagnostics += `  [${i}] ${kinds[i].kind}\n`;
  }
  diagnostics += '\nLIQUIDATE:\n';
  diagnostics += `  [${liquidateIdx}] ${kinds[liquidateIdx].kind}\n`;
  if (hasFarmsRefresh && liquidateIdx + 1 < kinds.length) {
    diagnostics += '\nPOST (immediately after liquidation):\n';
    diagnostics += `  [${liquidateIdx + 1}] ${kinds[liquidateIdx + 1].kind}\n`;
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
