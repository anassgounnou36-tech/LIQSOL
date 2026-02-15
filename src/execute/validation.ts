/**
 * Compiled instruction validation for v0 transactions.
 * 
 * Provides semantic matching of liquidation instructions by programId + discriminator,
 * and validates the instruction window around liquidation for KLend adjacency rules.
 */

import { VersionedTransaction } from "@solana/web3.js";
import {
  KLEND_PROGRAM_ID,
  KAMINO_DISCRIMINATORS,
  decodeInstructionKind,
  extractDiscriminator,
  type CompiledInstructionInfo,
  type InstructionKind,
} from "./decodeKaminoKindFromCompiled.js";

/**
 * Decode all compiled instructions from a v0 transaction.
 * 
 * Extracts program ID, discriminator, and instruction kind for each instruction
 * in the compiled message.
 * 
 * @param tx - Compiled versioned transaction
 * @returns Array of instruction info in message order
 */
export function decodeCompiledInstructions(tx: VersionedTransaction): CompiledInstructionInfo[] {
  const message = tx.message;
  const instructions = message.compiledInstructions;
  const accountKeys = message.staticAccountKeys;
  
  return instructions.map((ix: any) => {
    const programIdKey = accountKeys[ix.programIdIndex];
    const programId = programIdKey.toBase58();
    
    // Extract discriminator (first 8 bytes of data)
    const discriminator = extractDiscriminator(ix.data);
    
    // Decode instruction kind
    const kind = decodeInstructionKind(programId, discriminator, ix.data);
    
    return {
      programId,
      discriminator,
      kind,
    };
  });
}

/**
 * Find liquidation instruction index in compiled transaction.
 * 
 * Searches for the liquidation instruction by matching:
 * 1. Program ID equals KLend program
 * 2. Discriminator matches liquidateObligationAndRedeemReserveCollateral
 * 
 * This is semantic matching that works reliably with v0 compiled transactions.
 * 
 * @param tx - Compiled versioned transaction
 * @returns Index of liquidation instruction, or -1 if not found
 */
export function findLiquidationIndex(tx: VersionedTransaction): number {
  const instructions = decodeCompiledInstructions(tx);
  const klendProgramId = KLEND_PROGRAM_ID.toBase58();
  const liquidateDiscriminator = KAMINO_DISCRIMINATORS.liquidateObligationAndRedeemReserveCollateral;
  
  return instructions.findIndex(ix => 
    ix.programId === klendProgramId && 
    ix.discriminator === liquidateDiscriminator
  );
}

/**
 * Validation result with diagnostics
 */
export interface ValidationResult {
  valid: boolean;
  diagnostics: string;
  liquidationIndex?: number;
}

/**
 * Validate liquidation instruction window with strict KLend adjacency rules.
 * 
 * Expected canonical sequence:
 * 
 * PRE (contiguous, immediately before liquidation):
 * - refreshReserve (collateral)
 * - refreshReserve (repay)
 * - refreshObligation
 * - refreshFarmsForObligationForReserve (0-2 instructions, if farms exist)
 * 
 * LIQUIDATE:
 * - liquidateObligationAndRedeemReserveCollateral
 * 
 * POST (immediately after liquidation):
 * - refreshFarmsForObligationForReserve (same farm set as PRE, if farms exist)
 * 
 * Key validation points:
 * 1. Liquidation instruction must be found
 * 2. PRE sequence must match canonical order
 * 3. POST sequence must match canonical order (if farms exist)
 * 
 * @param tx - Compiled versioned transaction
 * @param hasFarmsRefresh - Whether farms refresh instructions should be present
 * @returns Validation result with detailed diagnostics
 */
export function validateLiquidationWindow(
  tx: VersionedTransaction,
  hasFarmsRefresh: boolean
): ValidationResult {
  const kinds = decodeCompiledInstructions(tx);
  
  // Find liquidation instruction using semantic matching
  const liquidateIdx = findLiquidationIndex(tx);
  
  if (liquidateIdx === -1) {
    // Enhanced diagnostics: show what we found instead
    let diagnostics = 'Liquidation instruction not found in compiled transaction.\n\n';
    diagnostics += 'Searched for:\n';
    diagnostics += `  Program ID: ${KLEND_PROGRAM_ID.toBase58()}\n`;
    diagnostics += `  Discriminator: ${KAMINO_DISCRIMINATORS.liquidateObligationAndRedeemReserveCollateral}\n\n`;
    diagnostics += 'Instructions in compiled message:\n';
    
    kinds.forEach((kind, idx) => {
      const discStr = kind.discriminator ? kind.discriminator : 'none';
      diagnostics += `  [${idx}] ${kind.kind} (program: ${kind.programId.substring(0, Math.min(12, kind.programId.length))}..., disc: ${discStr})\n`;
    });
    
    return {
      valid: false,
      diagnostics,
      liquidationIndex: undefined,
    };
  }
  
  // Build expected PRE sequence
  // Order: reserves(collateral, repay) → obligation → farms (if exist)
  const expectedPreSequence: InstructionKind[] = hasFarmsRefresh
    ? ['refreshReserve', 'refreshReserve', 'refreshObligation', 'refreshObligationFarmsForReserve']
    : ['refreshReserve', 'refreshReserve', 'refreshObligation'];
  
  // Validate PRE sequence
  const preStartIdx = liquidateIdx - expectedPreSequence.length;
  if (preStartIdx < 0) {
    return {
      valid: false,
      diagnostics: `Not enough instructions before liquidation. Expected ${expectedPreSequence.length}, found ${liquidateIdx}`,
      liquidationIndex: liquidateIdx,
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
      diagnostics += `  [${i}] ${kinds[i].kind} (${kinds[i].programId.substring(0, Math.min(8, kinds[i].programId.length))}...)${marker}\n`;
    }
    
    return { valid: false, diagnostics, liquidationIndex: liquidateIdx };
  }
  
  // Validate POST sequence (farms refresh immediately after liquidation, if farms exist)
  if (hasFarmsRefresh) {
    const postIdx = liquidateIdx + 1;
    if (postIdx >= kinds.length) {
      return {
        valid: false,
        diagnostics: 'POST farms refresh expected but no instruction found after liquidation',
        liquidationIndex: liquidateIdx,
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
        diagnostics += `  [${i}] ${kinds[i].kind} (${kinds[i].programId.substring(0, Math.min(8, kinds[i].programId.length))}...)${marker}\n`;
      }
      
      return { valid: false, diagnostics, liquidationIndex: liquidateIdx };
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
  
  return { valid: true, diagnostics, liquidationIndex: liquidateIdx };
}
