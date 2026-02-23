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
import {
  KAMINO_DISCRIMINATORS,
  KNOWN_PROGRAM_IDS,
  decodeInstructionKind,
  extractDiscriminator,
} from "../execute/decodeKaminoKindFromCompiled.js";

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
  missingAtas: Array<{ mint: string; ataAddress: string; purpose: 'repay' | 'collateral' | 'withdrawLiq' }>;
  
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
 * 3. preRefreshReserve (N refreshReserve for all obligation reserves, deposits→borrows)
 * 4. refreshObligation (with remaining accounts ordered deposits→borrows)
 * 5. refreshFarmsForObligationForReserve (0-2 instructions for collateral/debt farms, if exist)
 * 
 * LIQUIDATE:
 * 6. liquidateObligationAndRedeemReserveCollateral
 * 
 * POST BLOCK (immediately after liquidation):
 * 7. refreshFarmsForObligationForReserve (same farm set and order as PRE, if exist)
 * 
 * 8. swap instructions (if provided, after POST farms)
 * 9. flashRepay (if using flashloan)
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
  
  // 3. PRE-RESERVE instructions (all obligation reserves, deposits→borrows)
  instructions.push(...liquidationResult.preReserveIxs);
  for (let i = 0; i < liquidationResult.preReserveIxs.length; i++) {
    labels.push(`preRefreshReserve:${i}`);
  }
  
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
    missingAtas: liquidationResult.missingAtas,
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
    
    // Extract discriminator using centralized helper
    const discriminator = extractDiscriminator(ix.data);
    
    // Decode kind using centralized decoder
    const kind = decodeInstructionKind(programId, discriminator, ix.data);
    
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
 * - refreshReserve (N contiguous instructions, one per obligation reserve)
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
 * 3. Contiguous refreshReserve run before refreshObligation must be valid (min 2)
 * 
 * Uses semantic matching by programId + discriminator for reliable v0 transaction validation.
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
  
  // Find liquidation instruction using semantic matching (programId + discriminator)
  const klendProgramId = KNOWN_PROGRAM_IDS.KAMINO_KLEND;
  const liquidateDiscriminator = KAMINO_DISCRIMINATORS.liquidateObligationAndRedeemReserveCollateral;
  const liquidateIdx = kinds.findIndex(k => 
    k.programId === klendProgramId && 
    k.discriminator === liquidateDiscriminator
  );
  
  if (liquidateIdx === -1) {
    // Enhanced diagnostics: show what instructions we found
    let diagnostics = 'Liquidation instruction not found in compiled transaction.\n\n';
    diagnostics += 'Searched for:\n';
    diagnostics += `  Program ID: ${klendProgramId}\n`;
    diagnostics += `  Discriminator: ${liquidateDiscriminator}\n\n`;
    diagnostics += 'Instructions in compiled message:\n';
    kinds.forEach((kind, idx) => {
      const discStr = kind.discriminator ?? 'none';
      diagnostics += `  [${idx}] ${kind.kind} (program: ${kind.programId.substring(0, Math.min(12, kind.programId.length))}..., disc: ${discStr})\n`;
    });
    return {
      valid: false,
      diagnostics,
    };
  }
  
  let cursor = liquidateIdx - 1;

  if (hasFarmsRefresh) {
    if (cursor < 0 || kinds[cursor].kind !== 'refreshObligationFarmsForReserve') {
      let diagnostics = 'Missing or invalid farms refresh immediately before liquidation\n\n';
      diagnostics += 'Expected: refreshObligationFarmsForReserve\n';
      diagnostics += `Actual: ${cursor >= 0 ? kinds[cursor].kind : 'none'}\n`;
      diagnostics += '\nFull instruction window (9-instruction window around liquidation):\n';
      const windowStart = Math.max(0, liquidateIdx - 6);
      const windowEnd = Math.min(kinds.length, liquidateIdx + 3);
      for (let i = windowStart; i < windowEnd; i++) {
        const marker = i === liquidateIdx ? ' ← LIQUIDATE' : '';
        diagnostics += `  [${i}] ${kinds[i].kind} (${kinds[i].programId.slice(0, 8)}...)${marker}\n`;
      }
      return { valid: false, diagnostics };
    }
    cursor -= 1;
  }

  if (cursor < 0 || kinds[cursor].kind !== 'refreshObligation') {
    let diagnostics = 'Missing or invalid refreshObligation before liquidation\n\n';
    diagnostics += 'Expected: refreshObligation\n';
    diagnostics += `Actual: ${cursor >= 0 ? kinds[cursor].kind : 'none'}\n`;
    diagnostics += '\nFull instruction window (9-instruction window around liquidation):\n';
    const windowStart = Math.max(0, liquidateIdx - 6);
    const windowEnd = Math.min(kinds.length, liquidateIdx + 3);
    for (let i = windowStart; i < windowEnd; i++) {
      const marker = i === liquidateIdx ? ' ← LIQUIDATE' : '';
      diagnostics += `  [${i}] ${kinds[i].kind} (${kinds[i].programId.slice(0, 8)}...)${marker}\n`;
    }
    return { valid: false, diagnostics };
  }

  const obligationIdx = cursor;
  cursor -= 1;

  let nPreReserves = 0;
  while (cursor >= 0 && kinds[cursor].kind === 'refreshReserve') {
    nPreReserves += 1;
    cursor -= 1;
  }

  if (nPreReserves < 2) {
    let diagnostics = 'Invalid PRE reserve window before refreshObligation\n\n';
    diagnostics += `Expected at least 2 contiguous refreshReserve instructions immediately before refreshObligation\n`;
    diagnostics += `Actual contiguous refreshReserve count: ${nPreReserves}\n`;
    diagnostics += '\nFull instruction window (9-instruction window around liquidation):\n';
    const windowStart = Math.max(0, liquidateIdx - 6);
    const windowEnd = Math.min(kinds.length, liquidateIdx + 3);
    for (let i = windowStart; i < windowEnd; i++) {
      const marker = i === liquidateIdx ? ' ← LIQUIDATE' : i === obligationIdx ? ' ← REFRESH OBLIGATION' : '';
      diagnostics += `  [${i}] ${kinds[i].kind} (${kinds[i].programId.slice(0, 8)}...)${marker}\n`;
    }
    return { valid: false, diagnostics };
  }

  const preStartIdx = obligationIdx - nPreReserves;

  if (preStartIdx < 0) {
    return {
      valid: false,
      diagnostics: `Not enough instructions before liquidation to include ${nPreReserves} reserve refreshes`,
    };
  }

  const actualPreSequence = kinds.slice(preStartIdx, liquidateIdx).map(k => k.kind);
  const expectedPreSequence = [
    ...Array(nPreReserves).fill('refreshReserve'),
    'refreshObligation',
    ...(hasFarmsRefresh ? ['refreshObligationFarmsForReserve'] : []),
  ];

  const preMatches = expectedPreSequence.every((expected, idx) => actualPreSequence[idx] === expected);
  if (!preMatches) {
    let diagnostics = 'Compiled PRE instruction window does not match expected sequence\n\n';
    diagnostics += `Expected PRE sequence with ${nPreReserves} reserve refresh(es) immediately before liquidation:\n`;
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
  diagnostics += `Validated canonical sequence around liquidation (${nPreReserves} PRE reserve refreshes):\n\n`;
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
