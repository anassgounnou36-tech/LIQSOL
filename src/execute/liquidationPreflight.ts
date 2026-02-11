/**
 * Liquidation preflight validation
 * 
 * Performs fresh on-chain checks before building liquidation transactions to:
 * 1. Load current obligation state
 * 2. Recompute liquidation eligibility (health ratio < 1.0)
 * 3. Validate reserve selection (repay in borrows, collateral in deposits)
 * 
 * This reduces false positives from stale predictions and avoids simulation errors
 * by failing early with clear diagnostics.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { KaminoMarket, KaminoObligation } from '@kamino-finance/klend-sdk';
import { createSolanaRpc, address } from '@solana/kit';
import { computeHealthRatio, type HealthRatioInput } from '../math/health.js';
import { isLiquidatable } from '../math/liquidation.js';
import { loadReserves, type ReserveCache } from '../cache/reserveCache.js';
import { loadOraclePrices, type OraclePriceCache } from '../cache/oracleCache.js';

export interface PreflightParams {
  connection: Connection;
  marketPubkey: PublicKey;
  programId: PublicKey;
  obligationPubkey: PublicKey;
  repayMintPreference?: PublicKey;
}

export interface PreflightResult {
  success: true;
  healthRatio: number;
  repayMintValid: boolean;
  collateralExists: boolean;
}

export interface PreflightFailure {
  success: false;
  reason: 
    | 'preflight_market_load_failed'
    | 'preflight_obligation_load_failed'
    | 'preflight_not_liquidatable'
    | 'preflight_health_unscored'
    | 'preflight_no_borrows'
    | 'preflight_no_deposits'
    | 'preflight_repay_not_in_borrows'
    | 'preflight_no_collateral';
  details?: string;
  healthRatio?: number;
}

export type PreflightCheckResult = PreflightResult | PreflightFailure;

/**
 * Perform preflight checks on liquidation before building transaction
 * 
 * This function:
 * 1. Loads fresh market + obligation data from chain
 * 2. Loads current reserves and oracle prices
 * 3. Computes current health ratio
 * 4. Checks if obligation is currently liquidatable (health < 1.0)
 * 5. Validates repay mint exists in borrows (if provided)
 * 6. Validates collateral exists in deposits
 * 
 * @param params - Preflight check parameters
 * @returns Result indicating success or reason for failure
 */
export async function checkLiquidationPreflight(
  params: PreflightParams
): Promise<PreflightCheckResult> {
  const { connection, marketPubkey, programId, obligationPubkey, repayMintPreference } = params;
  
  try {
    // 1. Load market from Kamino SDK
    const rpc = createSolanaRpc(connection.rpcEndpoint);
    const market = await KaminoMarket.load(
      rpc,
      address(marketPubkey.toBase58()),
      1000, // recentSlotDurationMs
      address(programId.toBase58())
    );
    
    if (!market) {
      return {
        success: false,
        reason: 'preflight_market_load_failed',
        details: `Failed to load market ${marketPubkey.toBase58()}`,
      };
    }
    
    // 2. Load obligation
    const obligation = await KaminoObligation.load(
      market,
      address(obligationPubkey.toBase58())
    );
    
    if (!obligation) {
      return {
        success: false,
        reason: 'preflight_obligation_load_failed',
        details: `Failed to load obligation ${obligationPubkey.toBase58()}`,
      };
    }
    
    // 3. Check for active borrows and deposits
    const borrows = obligation.state.borrows.filter(
      (b: any) => b.borrowReserve.toString() !== PublicKey.default.toString()
    );
    
    const deposits = obligation.state.deposits.filter(
      (d: any) => d.depositReserve.toString() !== PublicKey.default.toString()
    );
    
    if (borrows.length === 0) {
      return {
        success: false,
        reason: 'preflight_no_borrows',
        details: 'Obligation has no active borrows',
      };
    }
    
    if (deposits.length === 0) {
      return {
        success: false,
        reason: 'preflight_no_deposits',
        details: 'Obligation has no active deposits',
      };
    }
    
    // 4. Load reserves and oracle prices for health computation
    const reserves = await loadReserves(connection, marketPubkey);
    const oraclePrices = await loadOraclePrices(connection, reserves);
    
    // 5. Convert obligation deposits/borrows to format expected by health computation
    const obligationDeposits = deposits.map((d: any) => {
      const reserve = market.getReserveByAddress(address(d.depositReserve.toString()));
      return {
        mint: reserve?.getLiquidityMint() ?? '',
        reserve: d.depositReserve.toString(),
        depositedAmount: d.depositedAmount.toString(),
      };
    });
    
    const obligationBorrows = borrows.map((b: any) => {
      const reserve = market.getReserveByAddress(address(b.borrowReserve.toString()));
      return {
        mint: reserve?.getLiquidityMint() ?? '',
        reserve: b.borrowReserve.toString(),
        borrowedAmount: b.borrowedAmountSf.toString(),
      };
    });
    
    // 6. Compute current health ratio
    const healthInput: HealthRatioInput = {
      deposits: obligationDeposits,
      borrows: obligationBorrows,
      reserves: reserves.byMint,
      prices: oraclePrices.byMint,
    };
    
    const healthResult = computeHealthRatio(healthInput);
    
    if (!healthResult.scored) {
      return {
        success: false,
        reason: 'preflight_health_unscored',
        details: `Health computation failed: ${healthResult.reason}`,
      };
    }
    
    const healthRatio = healthResult.healthRatio;
    
    // 7. Check if liquidatable (health < 1.0)
    if (!isLiquidatable(healthRatio)) {
      return {
        success: false,
        reason: 'preflight_not_liquidatable',
        details: `Health ratio ${healthRatio.toFixed(4)} >= 1.0`,
        healthRatio,
      };
    }
    
    // 8. Validate repay mint if provided
    let repayMintValid = true;
    if (repayMintPreference) {
      const repayMintStr = repayMintPreference.toBase58();
      
      // Check if repay mint exists in borrows
      const borrowMints = new Set(obligationBorrows.map(b => b.mint));
      
      if (!borrowMints.has(repayMintStr)) {
        return {
          success: false,
          reason: 'preflight_repay_not_in_borrows',
          details: `Repay mint ${repayMintStr} not found in obligation borrows`,
          healthRatio,
        };
      }
    }
    
    // 9. Validate collateral exists
    const collateralExists = deposits.length > 0;
    if (!collateralExists) {
      return {
        success: false,
        reason: 'preflight_no_collateral',
        details: 'No collateral deposits found',
        healthRatio,
      };
    }
    
    // All checks passed
    return {
      success: true,
      healthRatio,
      repayMintValid,
      collateralExists,
    };
    
  } catch (error) {
    return {
      success: false,
      reason: 'preflight_obligation_load_failed',
      details: error instanceof Error ? error.message : String(error),
    };
  }
}
