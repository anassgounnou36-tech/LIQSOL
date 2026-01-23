import { PublicKey } from "@solana/web3.js";

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
  /** Total amount borrowed (as string to avoid precision loss) */
  totalBorrowed: string;
  /** Available liquidity for borrowing (as string to avoid precision loss) */
  availableLiquidity: string;
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
