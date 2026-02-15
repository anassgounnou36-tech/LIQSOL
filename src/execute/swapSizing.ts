import { Connection, PublicKey, TransactionInstruction, VersionedTransaction, TransactionMessage, Keypair } from '@solana/web3.js';

// Basis points divisor for percentage calculations
const BIPS_DIVISOR = 10000n;

/**
 * Parameters for estimating seized collateral from liquidation simulation
 */
export interface EstimateSeizedCollateralParams {
  connection: Connection;
  signer: Keypair;
  instructions: TransactionInstruction[]; // Pre-liquidation ixs (ComputeBudget + FlashBorrow + Refresh + Liquidation, NO swap/repay)
  collateralMint: PublicKey;
  liquidatorPubkey: PublicKey;
}

/**
 * Result from seized collateral estimation
 */
export interface SeizedCollateralEstimate {
  amountBaseUnits: bigint;
  amountWithHaircut: bigint; // Amount after applying safety haircut
  haircutBps: number;
}

/**
 * Strategy A: Simulate liquidation and estimate seized collateral amount
 * 
 * This function:
 * 1. Builds a pre-simulation transaction (ComputeBudget + flashBorrow + canonical liquidation ixs)
 * 2. Simulates it to estimate seized collateral
 * 3. Parses simulation logs or account state to extract collateral amount
 * 4. Applies safety haircut (SWAP_IN_HAIRCUT_BPS) to avoid oversizing
 * 
 * Canonical liquidation order: preReserveIxs → coreIxs → liquidationIxs → postFarmIxs
 * 
 * @param params - Simulation parameters
 * @returns Estimated seized collateral amount with safety haircut applied
 * @throws Error if simulation fails or collateral cannot be estimated
 */
export async function estimateSeizedCollateral(
  params: EstimateSeizedCollateralParams
): Promise<SeizedCollateralEstimate> {
  const { connection, signer, instructions, collateralMint } = params;
  
  // Get haircut from env (default 100 bps = 1%)
  const haircutBps = Number(process.env.SWAP_IN_HAIRCUT_BPS ?? 100);
  
  console.log(`[SwapSizing] Estimating seized collateral for mint ${collateralMint.toBase58()}`);
  console.log(`[SwapSizing] Safety haircut: ${haircutBps} bps (${haircutBps / 100}%)`);
  
  try {
    // Build and sign simulation transaction
    const bh = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: bh.blockhash,
      instructions,
    }).compileToLegacyMessage();
    const tx = new VersionedTransaction(msg);
    tx.sign([signer]);
    
    // Simulate transaction
    console.log('[SwapSizing] Running pre-simulation...');
    const simStart = Date.now();
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    const simMs = Date.now() - simStart;
    
    if (sim.value.err) {
      console.error('[SwapSizing] Simulation failed:', JSON.stringify(sim.value.err, null, 2));
      throw new Error(`Liquidation simulation failed: ${JSON.stringify(sim.value.err)}`);
    }
    
    console.log(`[SwapSizing] Simulation completed in ${simMs}ms`);
    console.log(`[SwapSizing] CU used: ${sim.value.unitsConsumed ?? 'unknown'}`);
    
    // Strategy: Parse simulation logs for token balance changes
    // Look for program log entries like "Transfer: amount XXX"
    const logs = sim.value.logs ?? [];
    let seizedAmount = 0n;
    
    // First, try to parse logs for transfer amounts
    // Look for Kamino-specific log patterns with more specific matching
    for (const log of logs) {
      // Look for Kamino liquidation program logs indicating collateral seized
      // Pattern: Match "seized XXX" or "withdrawn XXX" where XXX is the amount
      if (log.includes('seized') || log.includes('Seized') || log.includes('withdrawn') || log.includes('Withdrawn')) {
        // More specific pattern: match digits after the keyword
        const seizedMatch = log.match(/(?:seized|Seized|withdrawn|Withdrawn).*?(\d+)/);
        if (seizedMatch) {
          const amount = BigInt(seizedMatch[1]);
          if (amount > seizedAmount) {
            seizedAmount = amount;
            console.log(`[SwapSizing] Found seized amount in logs: ${seizedAmount} base units`);
          }
        }
      }
    }
    
    // If log parsing fails, account state approach is not available in web3.js 1.x simulation
    if (seizedAmount === 0n) {
      console.log('[SwapSizing] No seized amount found in logs');
      console.log('[SwapSizing] Account state parsing not available in simulation');
      console.log('[SwapSizing] Consider using deterministic calculation or providing explicit amount');
      
      // Fallback: Use a conservative estimate if we have liquidation context
      // This is not ideal but prevents blocking
      throw new Error(
        'Unable to estimate seized collateral from simulation. ' +
        'Log parsing did not find amount and account state is not available. ' +
        'Please provide explicit repayAmountUi or use deterministic calculation fallback.'
      );
    }
    
    // Apply safety haircut
    const haircutMultiplier = BIPS_DIVISOR - BigInt(haircutBps);
    const amountWithHaircut = (seizedAmount * haircutMultiplier) / BIPS_DIVISOR;
    
    console.log(`[SwapSizing] Estimated seized: ${seizedAmount} base units`);
    console.log(`[SwapSizing] After ${haircutBps} bps haircut: ${amountWithHaircut} base units`);
    
    return {
      amountBaseUnits: seizedAmount,
      amountWithHaircut,
      haircutBps,
    };
    
  } catch (err) {
    console.error('[SwapSizing] Error estimating seized collateral:', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Fallback: Deterministic calculation of seized collateral (if simulation approach fails)
 * 
 * This uses obligation state and reserve configuration to estimate seized amount mathematically.
 * Requires access to obligation borrows, deposits, and reserve configurations.
 * 
 * NOT IMPLEMENTED YET - placeholder for future enhancement
 */
export async function calculateSeizedCollateralDeterministic(
  /* params */
): Promise<SeizedCollateralEstimate> {
  throw new Error('Deterministic seized collateral calculation not yet implemented. Use simulation-based approach.');
}
