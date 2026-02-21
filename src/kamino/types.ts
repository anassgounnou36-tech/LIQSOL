/**
 * Decoded Reserve account from Kamino Lending protocol.
 * Represents a lending reserve with liquidity, collateral, and configuration.
 */
export interface DecodedReserve {
  /** Public key of the reserve account */
  reservePubkey: string;
  /** Public key of the lending market this reserve belongs to */
  marketPubkey: string;
  /** Public key of the liquidity token mint */
  liquidityMint: string;
  /** Public key of the collateral token mint */
  collateralMint: string;
  /** Decimals of the liquidity token */
  liquidityDecimals: number;
  /** Decimals of the collateral token (typically same as liquidity) */
  collateralDecimals: number;
  /** Array of oracle public keys used for price feeds (Pyth, Switchboard, Scope) */
  oraclePubkeys: string[];
  /** Loan-to-value ratio as a percentage (0-100) */
  loanToValueRatio: number;
  /** Liquidation threshold as a percentage (0-100) */
  liquidationThreshold: number;
  /** Liquidation bonus in basis points */
  liquidationBonus: number;
  /** Borrow factor as a percentage (0-100+) for risk-adjusted debt valuation */
  borrowFactor: number;
  /** Available liquidity amount (raw, not adjusted for decimals) */
  availableAmountRaw: string;
  /** Borrowed amount in SF (scaled fraction, 1e18-scaled) */
  borrowedAmountSfRaw: string;
  /** Cumulative borrow rate BSF (BigFractionBytes as bigint string) - used for individual borrow conversion only */
  cumulativeBorrowRateBsfRaw: string;
  /** Total supply of collateral mint tokens */
  collateralMintTotalSupplyRaw: string;
  /** Scope price chain indices array (0-511) for multi-chain Scope oracles with fallback, null if not using Scope */
  scopePriceChain: number[] | null;
}

/**
 * Decoded Obligation account from Kamino Lending protocol.
 * Represents a user's borrowing position with collateral deposits and loans.
 */
export interface DecodedObligation {
  /** Public key of the obligation account */
  obligationPubkey: string;
  /** Public key of the obligation owner (user) */
  ownerPubkey: string;
  /** Public key of the lending market */
  marketPubkey: string;
  /** Last update slot number */
  lastUpdateSlot: string;
  /** Array of deposited collateral positions */
  deposits: ObligationDeposit[];
  /** Array of borrowed positions */
  borrows: ObligationBorrow[];

  // Protocol SF risk values (optional - decoded directly from on-chain Obligation account)
  /** Raw deposited value in SF (1e18-scaled), stored as string to avoid Number() overflow */
  depositedValueSfRaw?: string;
  /** Raw borrowed assets market value in SF (1e18-scaled) */
  borrowedAssetsMarketValueSfRaw?: string;
  /** Borrow-factor-adjusted debt value in SF (1e18-scaled) */
  borrowFactorAdjustedDebtValueSfRaw?: string;
  /** Allowed borrow value in SF (1e18-scaled) */
  allowedBorrowValueSfRaw?: string;
  /** Unhealthy borrow value (borrow limit) in SF (1e18-scaled) */
  unhealthyBorrowValueSfRaw?: string;

  // Protocol metadata
  /** Lowest liquidation LTV among deposited reserves */
  lowestReserveDepositLiquidationLtv?: number;
  /** Lowest max LTV among deposited reserves */
  lowestReserveDepositMaxLtvPct?: number;
  /** Elevation group for the obligation */
  elevationGroup?: number;
  /** Highest borrow factor percentage among borrowed reserves */
  highestBorrowFactorPct?: number;
  /** Whether the obligation has any active debt */
  hasDebt?: boolean;
  /** Whether borrowing is disabled for this obligation */
  borrowingDisabled?: boolean;
}

/**
 * Represents a single collateral deposit in an obligation
 */
export interface ObligationDeposit {
  /** Public key of the reserve this deposit is in */
  reserve: string;
  /** Token mint of the deposited collateral */
  mint: string;
  /** Amount deposited (as string to avoid precision loss) */
  depositedAmount: string;
}

/**
 * Represents a single borrowed position in an obligation
 */
export interface ObligationBorrow {
  /** Public key of the reserve this borrow is from */
  reserve: string;
  /** Token mint of the borrowed asset */
  mint: string;
  /** Amount borrowed (as string to avoid precision loss) */
  borrowedAmount: string;
}
