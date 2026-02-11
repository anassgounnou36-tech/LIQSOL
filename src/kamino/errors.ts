/**
 * Kamino KLend error code decoder
 * 
 * Maps Kamino program error codes (Custom errors) to human-readable messages.
 * Error codes extracted from @kamino-finance/klend-sdk IDL.
 * 
 * Usage:
 *   const errorMsg = decodeKlendError(6006);
 *   console.log(errorMsg); // "InvalidAccountInput - Invalid account input"
 */

interface KlendError {
  name: string;
  msg: string;
}

/**
 * Mapping of Kamino KLend error codes to error details
 * Extracted from @kamino-finance/klend-sdk/dist/@codegen/klend/errors/custom.d.ts
 */
const KLEND_ERROR_MAP: Record<number, KlendError> = {
  6000: { name: 'InvalidMarketAuthority', msg: 'Market authority is invalid' },
  6001: { name: 'InvalidMarketOwner', msg: 'Market owner is invalid' },
  6002: { name: 'InvalidAccountOwner', msg: 'Input account owner is not the program address' },
  6003: { name: 'InvalidAmount', msg: 'Input amount is invalid' },
  6004: { name: 'InvalidConfig', msg: 'Input config value is invalid' },
  6005: { name: 'InvalidSigner', msg: 'Signer is not allowed to perform this action' },
  6006: { name: 'InvalidAccountInput', msg: 'Invalid account input' },
  6007: { name: 'MathOverflow', msg: 'Math operation overflow' },
  6008: { name: 'InsufficientLiquidity', msg: 'Insufficient liquidity available' },
  6009: { name: 'ReserveStale', msg: 'Reserve state needs to be refreshed' },
  6010: { name: 'WithdrawTooSmall', msg: 'Withdraw amount too small' },
  6011: { name: 'WithdrawTooLarge', msg: 'Withdraw amount too large' },
  6012: { name: 'BorrowTooSmall', msg: 'Borrow amount too small to receive liquidity after fees' },
  6013: { name: 'BorrowTooLarge', msg: 'Borrow amount too large for deposited collateral' },
  6014: { name: 'RepayTooSmall', msg: 'Repay amount too small to transfer liquidity' },
  6015: { name: 'LiquidationTooSmall', msg: 'Liquidation amount too small to receive collateral' },
  6016: { name: 'ObligationHealthy', msg: 'Cannot liquidate healthy obligations' },
  6017: { name: 'ObligationStale', msg: 'Obligation state needs to be refreshed' },
  6018: { name: 'ObligationReserveLimit', msg: 'Obligation reserve limit exceeded' },
  6019: { name: 'InvalidObligationOwner', msg: 'Obligation owner is invalid' },
  6020: { name: 'ObligationDepositsEmpty', msg: 'Obligation deposits are empty' },
  6021: { name: 'ObligationBorrowsEmpty', msg: 'Obligation borrows are empty' },
  6022: { name: 'ObligationDepositsZero', msg: 'Obligation deposits have zero value' },
  6023: { name: 'ObligationBorrowsZero', msg: 'Obligation borrows have zero value' },
  6024: { name: 'InvalidObligationCollateral', msg: 'Invalid obligation collateral' },
  6025: { name: 'InvalidObligationLiquidity', msg: 'Invalid obligation liquidity' },
  6026: { name: 'ObligationCollateralEmpty', msg: 'Obligation collateral is empty' },
  6027: { name: 'ObligationLiquidityEmpty', msg: 'Obligation liquidity is empty' },
  6028: { name: 'NegativeInterestRate', msg: 'Interest rate is negative' },
  6029: { name: 'InvalidOracleConfig', msg: 'Input oracle config is invalid' },
  6030: { name: 'InsufficientProtocolFeesToRedeem', msg: 'Insufficient protocol fees to redeem' },
  6031: { name: 'FlashBorrowCpi', msg: 'Flash borrow CPI not allowed' },
  6032: { name: 'NoFlashRepayFound', msg: 'No flash repay found' },
  6033: { name: 'InvalidFlashRepay', msg: 'Invalid flash repay' },
  6034: { name: 'FlashRepayCpi', msg: 'Flash repay CPI not allowed' },
  6035: { name: 'MultipleFlashBorrows', msg: 'Multiple flash borrows not allowed' },
  6036: { name: 'FlashLoansDisabled', msg: 'Flash loans are disabled' },
  6037: { name: 'SwitchboardV2Error', msg: 'Switchboard V2 error' },
  6038: { name: 'CouldNotDeserializeScope', msg: 'Could not deserialize scope' },
  6039: { name: 'PriceTooOld', msg: 'Price too old' },
  6040: { name: 'PriceTooDivergentFromTwap', msg: 'Price too divergent from TWAP' },
  6041: { name: 'InvalidTwapPrice', msg: 'Invalid TWAP price' },
  6042: { name: 'GlobalEmergencyMode', msg: 'Global emergency mode' },
  6043: { name: 'InvalidFlag', msg: 'Invalid flag' },
  6044: { name: 'PriceNotValid', msg: 'Price not valid' },
  6045: { name: 'PriceIsBiggerThanHeuristic', msg: 'Price is bigger than heuristic' },
  6046: { name: 'PriceIsLowerThanHeuristic', msg: 'Price is lower than heuristic' },
  6047: { name: 'PriceIsZero', msg: 'Price is zero' },
  6048: { name: 'PriceConfidenceTooWide', msg: 'Price confidence too wide' },
  6049: { name: 'IntegerOverflow', msg: 'Integer overflow' },
  6050: { name: 'NoFarmForReserve', msg: 'No farm for reserve' },
  6051: { name: 'IncorrectInstructionInPosition', msg: 'Incorrect instruction in position' },
  6052: { name: 'NoPriceFound', msg: 'No price found' },
  6053: { name: 'InvalidTwapConfig', msg: 'Invalid TWAP config' },
  6054: { name: 'InvalidPythPriceAccount', msg: 'Invalid Pyth price account' },
  6055: { name: 'InvalidSwitchboardAccount', msg: 'Invalid Switchboard account' },
  6056: { name: 'InvalidScopePriceAccount', msg: 'Invalid Scope price account' },
  6057: { name: 'ObligationCollateralLtvZero', msg: 'Obligation collateral LTV zero' },
  6058: { name: 'InvalidObligationSeedsValue', msg: 'Invalid obligation seeds value' },
  6059: { name: 'DeprecatedInvalidObligationId', msg: 'Deprecated invalid obligation ID' },
  6060: { name: 'InvalidBorrowRateCurvePoint', msg: 'Invalid borrow rate curve point' },
  6061: { name: 'InvalidUtilizationRate', msg: 'Invalid utilization rate' },
  6062: { name: 'CannotSocializeObligationWithCollateral', msg: 'Cannot socialize obligation with collateral' },
  6063: { name: 'ObligationEmpty', msg: 'Obligation empty' },
  6064: { name: 'WithdrawalCapReached', msg: 'Withdrawal cap reached' },
  6065: { name: 'LastTimestampGreaterThanCurrent', msg: 'Last timestamp greater than current' },
  6066: { name: 'LiquidationRewardTooSmall', msg: 'Liquidation reward too small' },
  6067: { name: 'IsolatedAssetTierViolation', msg: 'Isolated asset tier violation' },
  6068: { name: 'InconsistentElevationGroup', msg: 'Inconsistent elevation group' },
  6069: { name: 'InvalidElevationGroup', msg: 'Invalid elevation group' },
  6070: { name: 'InvalidElevationGroupConfig', msg: 'Invalid elevation group config' },
  6071: { name: 'UnhealthyElevationGroupLtv', msg: 'Unhealthy elevation group LTV' },
  6072: { name: 'ElevationGroupNewLoansDisabled', msg: 'Elevation group new loans disabled' },
  6073: { name: 'ReserveDeprecated', msg: 'Reserve deprecated' },
  6074: { name: 'ReferrerAccountNotInitialized', msg: 'Referrer account not initialized' },
  6075: { name: 'ReferrerAccountMintMissmatch', msg: 'Referrer account mint mismatch' },
  6076: { name: 'ReferrerAccountWrongAddress', msg: 'Referrer account wrong address' },
  6077: { name: 'ReferrerAccountReferrerMissmatch', msg: 'Referrer account referrer mismatch' },
  6078: { name: 'ReferrerAccountMissing', msg: 'Referrer account missing' },
  6079: { name: 'InsufficientReferralFeesToRedeem', msg: 'Insufficient referral fees to redeem' },
  6080: { name: 'CpiDisabled', msg: 'CPI disabled' },
  6081: { name: 'ShortUrlNotAsciiAlphanumeric', msg: 'Short URL not ASCII alphanumeric' },
  6082: { name: 'ReserveObsolete', msg: 'Reserve obsolete' },
  6083: { name: 'ElevationGroupAlreadyActivated', msg: 'Elevation group already activated' },
  6084: { name: 'ObligationInObsoleteReserve', msg: 'Obligation in obsolete reserve' },
  6085: { name: 'ReferrerStateOwnerMismatch', msg: 'Referrer state owner mismatch' },
  6086: { name: 'UserMetadataOwnerAlreadySet', msg: 'User metadata owner already set' },
  6087: { name: 'CollateralNonLiquidatable', msg: 'Collateral non-liquidatable' },
  6088: { name: 'BorrowingDisabled', msg: 'Borrowing disabled' },
  6089: { name: 'BorrowLimitExceeded', msg: 'Borrow limit exceeded' },
  6090: { name: 'DepositLimitExceeded', msg: 'Deposit limit exceeded' },
  6091: { name: 'BorrowingDisabledOutsideElevationGroup', msg: 'Borrowing disabled outside elevation group' },
  6092: { name: 'NetValueRemainingTooSmall', msg: 'Net value remaining too small' },
  6093: { name: 'WorseLtvBlocked', msg: 'Worse LTV blocked' },
  6094: { name: 'LiabilitiesBiggerThanAssets', msg: 'Liabilities bigger than assets' },
  6095: { name: 'ReserveTokenBalanceMismatch', msg: 'Reserve token balance mismatch' },
  6096: { name: 'ReserveVaultBalanceMismatch', msg: 'Reserve vault balance mismatch' },
  6097: { name: 'ReserveAccountingMismatch', msg: 'Reserve accounting mismatch' },
  6098: { name: 'BorrowingAboveUtilizationRateDisabled', msg: 'Borrowing above utilization rate disabled' },
  6099: { name: 'LiquidationBorrowFactorPriority', msg: 'Liquidation borrow factor priority' },
  6100: { name: 'LiquidationLowestLiquidationLtvPriority', msg: 'Liquidation lowest liquidation LTV priority' },
};

/**
 * Decode a Kamino KLend error code to a human-readable message
 * 
 * @param code - The error code from the Custom instruction error
 * @returns A string describing the error, or "Unknown error" if not found
 * 
 * @example
 * ```typescript
 * const errorMsg = decodeKlendError(6006);
 * console.log(errorMsg); // "InvalidAccountInput - Invalid account input"
 * ```
 */
export function decodeKlendError(code: number): string {
  const error = KLEND_ERROR_MAP[code];
  if (!error) {
    return `Unknown Kamino error code: ${code}`;
  }
  return `${error.name} - ${error.msg}`;
}

/**
 * Get just the error name without the message
 */
export function getKlendErrorName(code: number): string | null {
  return KLEND_ERROR_MAP[code]?.name ?? null;
}

/**
 * Get just the error message without the name
 */
export function getKlendErrorMsg(code: number): string | null {
  return KLEND_ERROR_MAP[code]?.msg ?? null;
}

/**
 * Check if a given code is a known Kamino error
 */
export function isKnownKlendError(code: number): boolean {
  return code in KLEND_ERROR_MAP;
}
