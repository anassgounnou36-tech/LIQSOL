import { DecodedObligation } from '../kamino/types.js';
import { divBigintToNumber } from '../utils/bn.js';

/** Scope framework scale factor: SF values are stored as 1e18-scaled integers */
const SF_SCALE = 10n ** 18n;

export interface ProtocolHealthResult {
  scored: boolean;
  healthRatio: number;
  healthRatioRaw: number;
  borrowValueUsd: number;
  collateralValueUsd: number;
  totalBorrowUsd: number;
  totalCollateralUsd: number;
  elevationGroup?: number;
  highestBorrowFactorPct?: number;
}

/**
 * Compute health ratio directly from Kamino's protocol-computed SF values stored
 * on the Obligation account.
 *
 * HR(protocol) = unhealthyBorrowValueSf / borrowFactorAdjustedDebtValueSf
 *
 * This provides a "ground truth" cross-check against the oracle+reserve recomputed
 * health ratio, surfacing math bugs, missing configs, or edge cases (elevation
 * groups, farms, special LTV).
 *
 * @param obligation - Decoded obligation with optional protocol SF fields
 * @returns Protocol health result; scored=false when SF fields are unavailable
 */
export function computeProtocolHealth(obligation: DecodedObligation): ProtocolHealthResult {
  if (
    !obligation.borrowFactorAdjustedDebtValueSfRaw ||
    !obligation.unhealthyBorrowValueSfRaw
  ) {
    return {
      scored: false,
      healthRatio: 0,
      healthRatioRaw: 0,
      borrowValueUsd: 0,
      collateralValueUsd: 0,
      totalBorrowUsd: 0,
      totalCollateralUsd: 0,
    };
  }

  // Parse SF values (stored as strings to avoid Number() overflow on large bigints)
  const borrowFactorAdjustedDebt = BigInt(obligation.borrowFactorAdjustedDebtValueSfRaw);
  const unhealthyBorrowValue = BigInt(obligation.unhealthyBorrowValueSfRaw);
  const borrowedAssetsMarketValue = BigInt(obligation.borrowedAssetsMarketValueSfRaw ?? '0');
  const depositedValue = BigInt(obligation.depositedValueSfRaw ?? '0');

  // Convert SF-scaled bigints to USD (divide by 1e18)
  const borrowValueUsd = divBigintToNumber(borrowFactorAdjustedDebt, SF_SCALE, 6);
  const collateralValueUsd = divBigintToNumber(unhealthyBorrowValue, SF_SCALE, 6);
  const totalBorrowUsd = divBigintToNumber(borrowedAssetsMarketValue, SF_SCALE, 6);
  const totalCollateralUsd = divBigintToNumber(depositedValue, SF_SCALE, 6);

  // Compute HR(protocol) = unhealthyBorrowValue / borrowFactorAdjustedDebt
  let healthRatioRaw = 0;
  if (borrowFactorAdjustedDebt > 0n) {
    healthRatioRaw = divBigintToNumber(unhealthyBorrowValue, borrowFactorAdjustedDebt, 6);
  } else if (unhealthyBorrowValue > 0n) {
    // No debt but has collateral - maximum health
    healthRatioRaw = 2.0;
  }

  // Clamp to [0, 2] for consistency with recomputed HR
  const healthRatio = Math.max(0, Math.min(2, healthRatioRaw));

  return {
    scored: true,
    healthRatio,
    healthRatioRaw,
    borrowValueUsd,
    collateralValueUsd,
    totalBorrowUsd,
    totalCollateralUsd,
    elevationGroup: obligation.elevationGroup,
    highestBorrowFactorPct: obligation.highestBorrowFactorPct,
  };
}
