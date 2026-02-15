import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, AccountLayout } from '@solana/spl-token';

/**
 * Parameters for estimating seized collateral delta using account state (NO log parsing)
 */
export interface EstimateSeizedCollateralDeltaParams {
  connection: Connection;
  liquidator: PublicKey;
  collateralMint: PublicKey;
  simulateTx: VersionedTransaction; // liquidation-only sim: NO flashBorrow/flashRepay
  instructionLabels?: string[]; // Optional labels for debugging failed simulations
}

/**
 * Deterministic seized collateral estimator using account post-state delta.
 * 
 * IMPORTANT: The simulateTx should contain ONLY the liquidation instruction sequence
 * WITHOUT flashBorrow/flashRepay to avoid error 6032 (NoFlashRepayFound):
 * 
 * Expected instruction order (NO flash loan, canonical KLend adjacency):
 * 1. ComputeBudget instructions (limit, optional price)
 * 
 * PRE BLOCK (contiguous):
 * 2. RefreshReserve (collateral reserve) - for RefreshObligation slot freshness
 * 3. RefreshReserve (repay reserve) - for RefreshObligation slot freshness
 * 4. RefreshObligation (with ALL reserves as remaining accounts)
 * 5. RefreshFarmsForObligationForReserve (collateral and/or debt, 0-2 instructions, if farms exist)
 * 
 * LIQUIDATE:
 * 6. LiquidateObligationAndRedeemReserveCollateral
 * 
 * POST BLOCK (immediately after liquidation):
 * 7. RefreshFarmsForObligationForReserve (mirrors PRE farms, if exist)
 * 
 * DO NOT include flashBorrow/flashRepay in the simulation - this isolates the
 * liquidation path for delta measurement and avoids flash loan pairing issues.
 * 
 * PRE reserve refresh instructions (steps 2-3) are required to prevent ReserveStale (6009)
 * during RefreshObligation. POST farms instructions (step 7) are required to satisfy
 * KLend's check_refresh adjacency validation immediately after liquidation.
 * 
 * Algorithm:
 * 1. Derive liquidator collateral ATA via getAssociatedTokenAddress(collateralMint, liquidator, true)
 *    This is the user_destination_collateral used by liquidation redemption (NOT withdrawLiq ATA)
 * 2. Fetch pre-balance in base units:
 *    - If ATA exists: use getTokenAccountBalance → parse amount string as bigint
 *    - If ATA missing: preBalance = 0; include idempotent ATA create ix in pre-sim build so post-state exists
 * 3. Simulate transaction with accounts config:
 *    - simulateTransaction(simulateTx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', accounts: { addresses: [collateralATA.toBase58()], encoding: 'base64' } })
 *    - Parse returned token account data (base64) and read post amount in base units
 * 4. seizedDelta = post - pre
 * 5. If seizedDelta <= 0: throw Error("[SeizedDelta] Liquidation produced no collateral delta")
 * 
 * @param params - Estimation parameters
 * @returns Seized collateral amount in base units as bigint
 * @throws Error if simulation fails or seized delta is non-positive
 */
export async function estimateSeizedCollateralDeltaBaseUnits(
  params: EstimateSeizedCollateralDeltaParams
): Promise<bigint> {
  const { connection, liquidator, collateralMint, simulateTx, instructionLabels } = params;

  console.log('[SeizedDelta] Estimating seized collateral using account-delta approach');
  console.log(`[SeizedDelta]   Liquidator: ${liquidator.toBase58()}`);
  console.log(`[SeizedDelta]   Collateral Mint: ${collateralMint.toBase58()}`);

  // 1) Derive liquidator collateral ATA
  // IMPORTANT: This is the user_destination_collateral used by liquidation redemption
  // (NOT the withdrawLiq ATA)
  const collateralATA = await getAssociatedTokenAddress(
    collateralMint,
    liquidator,
    true // allowOwnerOffCurve
  );

  console.log(`[SeizedDelta]   Monitoring Collateral ATA (user_destination_collateral): ${collateralATA.toBase58()}`);

  // 2) Fetch pre-balance in base units
  let preBalance = 0n;
  try {
    const tokenAccountInfo = await connection.getAccountInfo(collateralATA);
    
    if (tokenAccountInfo && tokenAccountInfo.data) {
      // Account exists - parse token account data
      const accountData = AccountLayout.decode(tokenAccountInfo.data);
      preBalance = accountData.amount;
      console.log(`[SeizedDelta]   Pre-balance: ${preBalance} base units`);
    } else {
      // Account doesn't exist yet - preBalance = 0
      console.log('[SeizedDelta]   Pre-balance: 0 (ATA does not exist yet)');
      preBalance = 0n;
    }
  } catch (err) {
    console.warn(
      '[SeizedDelta] Failed to fetch pre-balance (assuming 0):',
      err instanceof Error ? err.message : String(err)
    );
    preBalance = 0n;
  }

  // 3) Simulate transaction with accounts config to get post-state
  console.log('[SeizedDelta] Running simulation with account state...');
  const simStart = Date.now();

  let sim;
  try {
    sim = await connection.simulateTransaction(simulateTx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'processed',
      accounts: {
        addresses: [collateralATA.toBase58()],
        encoding: 'base64',
      },
    });
  } catch (err) {
    console.error('[SeizedDelta] Simulation failed:', err instanceof Error ? err.message : String(err));
    throw new Error(`Failed to simulate liquidation for seized delta estimation: ${err instanceof Error ? err.message : String(err)}`);
  }

  const simMs = Date.now() - simStart;
  console.log(`[SeizedDelta] Simulation completed in ${simMs}ms`);

  if (sim.value.err) {
    console.error('[SeizedDelta] Simulation error:', JSON.stringify(sim.value.err, null, 2));
    
    // Print instruction map for debugging
    if (instructionLabels && instructionLabels.length > 0) {
      console.error('\n[SeizedDelta] ═══ SIMULATION INSTRUCTION MAP ═══');
      instructionLabels.forEach((label, idx) => {
        console.error(`  [${idx}] ${label}`);
      });
      console.error('═════════════════════════════════════════\n');
    }
    
    throw new Error(`Liquidation simulation failed: ${JSON.stringify(sim.value.err)}`);
  }

  // 4) Parse post-state account data from simulation result
  if (!sim.value.accounts || sim.value.accounts.length === 0) {
    throw new Error('[SeizedDelta] No account data returned from simulation (accounts config may not be supported)');
  }

  const accountResult = sim.value.accounts[0];
  if (!accountResult || !accountResult.data) {
    throw new Error('[SeizedDelta] Collateral ATA data missing from simulation result');
  }

  // Parse base64 account data to extract token amount
  let postBalance = 0n;
  try {
    const [dataStr, encoding] = accountResult.data as [string, string];
    if (encoding !== 'base64') {
      throw new Error(`Unexpected encoding: ${encoding} (expected base64)`);
    }

    const buffer = Buffer.from(dataStr, 'base64');
    const accountData = AccountLayout.decode(buffer);
    postBalance = accountData.amount;
    console.log(`[SeizedDelta]   Post-balance: ${postBalance} base units`);
  } catch (err) {
    console.error('[SeizedDelta] Failed to parse post-state account data:', err instanceof Error ? err.message : String(err));
    throw new Error(`Failed to parse collateral ATA post-state: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5) Calculate seized delta
  const seizedDelta = postBalance - preBalance;
  console.log(`[SeizedDelta]   Seized delta: ${seizedDelta} base units`);

  if (seizedDelta <= 0n) {
    throw new Error(`[SeizedDelta] Liquidation produced no collateral delta (pre: ${preBalance}, post: ${postBalance}, delta: ${seizedDelta})`);
  }

  return seizedDelta;
}
