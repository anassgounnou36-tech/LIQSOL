/**
 * Shared validation utilities for FlashloanPlan objects
 */

import type { FlashloanPlan } from './txBuilder.js';

/**
 * Validates that a plan has all required fields for liquidation execution
 * A complete plan must have:
 * - repayReservePubkey (non-empty string)
 * - collateralReservePubkey (non-empty string)
 * - collateralMint (non-empty string)
 * 
 * @param plan - The plan to validate
 * @returns true if plan is complete, false otherwise
 */
export function isPlanComplete(plan: FlashloanPlan): boolean {
  return !!(
    plan.repayReservePubkey && 
    plan.repayReservePubkey.trim() !== '' &&
    plan.collateralReservePubkey && 
    plan.collateralReservePubkey.trim() !== '' &&
    plan.collateralMint && 
    plan.collateralMint.trim() !== ''
  );
}

/**
 * Gets a human-readable description of which fields are missing from a plan
 * 
 * @param plan - The plan to check
 * @returns Object with fields indicating which are missing
 */
export function getMissingFields(plan: FlashloanPlan): {
  repayReservePubkey: string;
  collateralReservePubkey: string;
  collateralMint: string;
} {
  return {
    repayReservePubkey: (!plan.repayReservePubkey || plan.repayReservePubkey.trim() === '') 
      ? 'missing' 
      : plan.repayReservePubkey,
    collateralReservePubkey: (!plan.collateralReservePubkey || plan.collateralReservePubkey.trim() === '')
      ? 'missing'
      : plan.collateralReservePubkey,
    collateralMint: (!plan.collateralMint || plan.collateralMint.trim() === '')
      ? 'missing'
      : plan.collateralMint,
  };
}
