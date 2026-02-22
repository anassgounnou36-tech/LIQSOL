/**
 * Kamino instruction discriminator mappings for compiled transaction validation.
 * 
 * Discriminators are the first 8 bytes of instruction data, computed as:
 * sha256("global:instruction_name")[0..8] for Anchor instructions.
 * Discriminators are derived from snake_case Rust method names, not camelCase.
 */

import { PublicKey } from "@solana/web3.js";

// Kamino KLend program ID (mainnet)
export const KLEND_PROGRAM_ID = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');

/**
 * Kamino KLend instruction discriminators (first 8 bytes of instruction data as hex)
 */
export const KAMINO_DISCRIMINATORS = {
  // Reserve operations
  refreshReserve: '02da8aeb4fc91966',
  
  // Obligation operations
  refreshObligation: '218493e497c04859',
  
  // Liquidation operations
  liquidateObligationAndRedeemReserveCollateral: 'b1479abce2854a37',
  
  // Farm operations
  refreshObligationFarmsForReserve: '8c90fd150a4af803',
  
  // Flash loan operations
  flashBorrowReserveLiquidity: '87e734a70734d4c1',
  flashRepayReserveLiquidity: 'b97500cb60f5b4ba',
} as const;

/**
 * Instruction kind classification for validation
 */
export type InstructionKind = 
  | 'refreshReserve'
  | 'refreshObligation'
  | 'liquidateObligationAndRedeemReserveCollateral'
  | 'refreshObligationFarmsForReserve'
  | 'flashBorrowReserveLiquidity'
  | 'flashRepayReserveLiquidity'
  | 'computeBudget:limit'
  | 'computeBudget:price'
  | 'computeBudget:unknown'
  | 'jupiter:swap'
  | 'token:instruction'
  | 'token2022:instruction'
  | 'ata:create'
  | 'kamino:unknown'
  | 'unknown';

/**
 * Known program IDs for instruction classification
 */
export const KNOWN_PROGRAM_IDS = {
  KAMINO_KLEND: 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
  COMPUTE_BUDGET: 'ComputeBudget111111111111111111111111111111',
  JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ATA: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
} as const;

/**
 * Decode instruction kind from program ID and discriminator.
 * 
 * @param programId - Program ID as base58 string
 * @param discriminator - First 8 bytes of instruction data as hex (optional)
 * @param data - Raw instruction data buffer (for compute budget)
 * @returns Human-readable instruction kind
 */
export function decodeInstructionKind(
  programId: string,
  discriminator: string | undefined,
  data?: Uint8Array
): InstructionKind {
  // Kamino KLend program
  if (programId === KNOWN_PROGRAM_IDS.KAMINO_KLEND) {
    if (!discriminator) return 'kamino:unknown';
    
    // Check against known discriminators
    for (const [kind, disc] of Object.entries(KAMINO_DISCRIMINATORS)) {
      if (discriminator === disc) {
        return kind as InstructionKind;
      }
    }
    
    return 'kamino:unknown';
  }
  
  // Compute Budget program
  if (programId === KNOWN_PROGRAM_IDS.COMPUTE_BUDGET) {
    if (data && data.length > 0) {
      const firstByte = data[0];
      if (firstByte === 0x02) return 'computeBudget:limit';
      if (firstByte === 0x03) return 'computeBudget:price';
    }
    return 'computeBudget:unknown';
  }
  
  // Jupiter V6 program
  if (programId === KNOWN_PROGRAM_IDS.JUPITER_V6) {
    return 'jupiter:swap';
  }
  
  // Token program
  if (programId === KNOWN_PROGRAM_IDS.TOKEN) {
    return 'token:instruction';
  }
  
  // Token-2022 program
  if (programId === KNOWN_PROGRAM_IDS.TOKEN_2022) {
    return 'token2022:instruction';
  }
  
  // ATA program
  if (programId === KNOWN_PROGRAM_IDS.ATA) {
    return 'ata:create';
  }
  
  return 'unknown';
}

/**
 * Compiled instruction metadata for validation
 */
export interface CompiledInstructionInfo {
  programId: string;
  discriminator?: string;
  kind: InstructionKind;
}

/**
 * Extract discriminator from instruction data.
 * Returns first 8 bytes as hex string if available.
 */
export function extractDiscriminator(data: Uint8Array): string | undefined {
  if (data.length >= 8) {
    return Buffer.from(data.slice(0, 8)).toString('hex');
  }
  return undefined;
}
