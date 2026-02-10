import { Connection, VersionedTransaction, TransactionMessage, Commitment, Keypair } from '@solana/web3.js';

/**
 * Classification of transaction send failures for retry logic
 */
export type FailureType = 
  | 'blockhash-expired'
  | 'blockhash-not-found'
  | 'compute-exceeded'
  | 'priority-too-low'
  | 'other';

/**
 * Result of a transaction send attempt
 */
export interface SendAttemptResult {
  success: boolean;
  signature?: string;
  error?: string;
  failureType?: FailureType;
  slot?: number;
  timingMs?: number;
  attemptNumber: number;
}

/**
 * Configuration for bounded retry logic
 */
export interface BroadcastRetryConfig {
  maxAttempts: number; // Max total send attempts (default: 2)
  cuLimit?: number; // Initial CU limit (default: from env EXEC_CU_LIMIT)
  cuPrice?: number; // Initial CU price in microlamports (default: from env EXEC_CU_PRICE)
  cuLimitBumpFactor?: number; // Multiply CU limit by this on compute exceeded (default: 1.5)
  cuPriceBumpMicrolamports?: number; // Add this to CU price on priority issues (default: 50000)
}

/**
 * Classify error message to determine failure type
 */
function classifyFailure(error: string): FailureType {
  const lower = error.toLowerCase();
  
  if (lower.includes('blockhash') && (lower.includes('expired') || lower.includes('not found'))) {
    if (lower.includes('expired')) return 'blockhash-expired';
    if (lower.includes('not found')) return 'blockhash-not-found';
  }
  
  if (lower.includes('compute') || lower.includes('exceeded') || lower.includes('cu limit')) {
    return 'compute-exceeded';
  }
  
  if (lower.includes('priority') || lower.includes('fee') || lower.includes('insufficient')) {
    return 'priority-too-low';
  }
  
  return 'other';
}

/**
 * Send transaction with bounded retries
 * 
 * Retry rules:
 * - Blockhash expired/not found: refresh blockhash and retry once
 * - Compute exceeded: log warning (NOTE: full implementation requires rebuilding tx with new CU budget)
 * - Priority too low: log warning (NOTE: full implementation requires rebuilding tx with new CU price)
 * - Other errors: no retry
 * 
 * NOTE: CU limit and priority fee bumps log the intent but don't rebuild the transaction.
 * Full implementation would require passing instructions and rebuilding with updated compute budget.
 * 
 * @param connection - Solana connection
 * @param tx - Transaction to send (will be rebuilt if blockhash needs refresh)
 * @param signer - Keypair for signing (needed for blockhash refresh)
 * @param message - Original transaction message (needed for rebuilding)
 * @param config - Retry configuration
 * @returns Array of attempt results
 */
export async function sendWithBoundedRetry(
  connection: Connection,
  tx: VersionedTransaction,
  signer: Keypair,
  message: TransactionMessage,
  config: BroadcastRetryConfig
): Promise<SendAttemptResult[]> {
  const attempts: SendAttemptResult[] = [];
  let currentTx = tx;
  let currentCuLimit = config.cuLimit;
  let currentCuPrice = config.cuPrice;
  
  for (let attemptNum = 1; attemptNum <= config.maxAttempts; attemptNum++) {
    console.log(`[Broadcast] Attempt ${attemptNum}/${config.maxAttempts}`);
    
    const attemptStart = Date.now();
    
    try {
      // Send transaction
      const signature = await connection.sendTransaction(currentTx, {
        skipPreflight: false,
        maxRetries: 0, // We handle retries ourselves
      });
      
      const sendMs = Date.now() - attemptStart;
      console.log(`[Broadcast] Transaction sent in ${sendMs}ms`);
      console.log(`[Broadcast] Signature: ${signature}`);
      
      // Wait for confirmation
      const confirmStart = Date.now();
      const confirmation = await connection.confirmTransaction({
        signature,
        blockhash: message.recentBlockhash,
        lastValidBlockHeight: (await connection.getBlockHeight()) + 150, // ~60 seconds at 400ms/slot
      }, 'confirmed' as Commitment);
      
      const confirmMs = Date.now() - confirmStart;
      const totalMs = Date.now() - attemptStart;
      
      if (confirmation.value.err) {
        // Confirmation failed
        const error = JSON.stringify(confirmation.value.err);
        console.error(`[Broadcast] Confirmation failed: ${error}`);
        
        const failureType = classifyFailure(error);
        attempts.push({
          success: false,
          signature,
          error,
          failureType,
          timingMs: totalMs,
          attemptNumber: attemptNum,
        });
        
        // Check if we should retry
        if (attemptNum < config.maxAttempts) {
          if (failureType === 'blockhash-expired' || failureType === 'blockhash-not-found') {
            console.log('[Broadcast] Refreshing blockhash and retrying...');
            const newBh = await connection.getLatestBlockhash();
            const newMsg = new TransactionMessage({
              payerKey: message.payerKey,
              recentBlockhash: newBh.blockhash,
              instructions: message.instructions,
            }).compileToLegacyMessage();
            currentTx = new VersionedTransaction(newMsg);
            currentTx.sign([signer]);
            continue;
          }
          
          if (failureType === 'compute-exceeded' && currentCuLimit) {
            const bumpFactor = config.cuLimitBumpFactor ?? 1.5;
            const newLimit = Math.floor(currentCuLimit * bumpFactor);
            console.log(`[Broadcast] Compute exceeded. Would bump CU limit from ${currentCuLimit} to ${newLimit}`);
            console.log(`[Broadcast] NOTE: CU limit bump requires rebuilding transaction - not implemented`);
            console.log(`[Broadcast] Retrying with original transaction...`);
            // NOTE: Full implementation would rebuild instructions with new CU budget
            currentCuLimit = newLimit;
            continue;
          }
          
          if (failureType === 'priority-too-low' && currentCuPrice !== undefined) {
            const bump = config.cuPriceBumpMicrolamports ?? 50000;
            const newPrice = currentCuPrice + bump;
            console.log(`[Broadcast] Priority too low. Would bump CU price from ${currentCuPrice} to ${newPrice} microlamports`);
            console.log(`[Broadcast] NOTE: Priority fee bump requires rebuilding transaction - not implemented`);
            console.log(`[Broadcast] Retrying with original transaction...`);
            // NOTE: Full implementation would rebuild instructions with new CU price
            currentCuPrice = newPrice;
            continue;
          }
        }
        
        // No retry condition met or max attempts reached
        break;
        
      } else {
        // Success!
        console.log('[Broadcast] Transaction confirmed successfully!');
        console.log(`[Broadcast] Timing: send=${sendMs}ms, confirm=${confirmMs}ms, total=${totalMs}ms`);
        
        // Try to get slot
        let slot: number | undefined;
        try {
          const status = await connection.getSignatureStatus(signature);
          slot = status.value?.slot;
        } catch {
          // Ignore slot fetch errors
        }
        
        attempts.push({
          success: true,
          signature,
          slot,
          timingMs: totalMs,
          attemptNumber: attemptNum,
        });
        
        return attempts; // Success - return immediately
      }
      
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const timingMs = Date.now() - attemptStart;
      
      console.error(`[Broadcast] Send failed: ${error}`);
      
      const failureType = classifyFailure(error);
      attempts.push({
        success: false,
        error,
        failureType,
        timingMs,
        attemptNumber: attemptNum,
      });
      
      // Check if we should retry
      if (attemptNum < config.maxAttempts) {
        if (failureType === 'blockhash-expired' || failureType === 'blockhash-not-found') {
          console.log('[Broadcast] Refreshing blockhash and retrying...');
          try {
            const newBh = await connection.getLatestBlockhash();
            const newMsg = new TransactionMessage({
              payerKey: message.payerKey,
              recentBlockhash: newBh.blockhash,
              instructions: message.instructions,
            }).compileToLegacyMessage();
            currentTx = new VersionedTransaction(newMsg);
            currentTx.sign([signer]);
            continue;
          } catch (refreshErr) {
            console.error('[Broadcast] Failed to refresh blockhash:', refreshErr instanceof Error ? refreshErr.message : String(refreshErr));
            break;
          }
        }
        
        if (failureType === 'compute-exceeded' && currentCuLimit) {
          const bumpFactor = config.cuLimitBumpFactor ?? 1.5;
          const newLimit = Math.floor(currentCuLimit * bumpFactor);
          console.log(`[Broadcast] Compute exceeded. Would bump CU limit from ${currentCuLimit} to ${newLimit}`);
          console.log(`[Broadcast] NOTE: CU limit bump requires rebuilding transaction - not implemented`);
          console.log(`[Broadcast] Retrying with original transaction...`);
          // NOTE: Full implementation would rebuild instructions with new CU budget
          currentCuLimit = newLimit;
          continue;
        }
        
        if (failureType === 'priority-too-low' && currentCuPrice !== undefined) {
          const bump = config.cuPriceBumpMicrolamports ?? 50000;
          const newPrice = currentCuPrice + bump;
          console.log(`[Broadcast] Priority too low. Would bump CU price from ${currentCuPrice} to ${newPrice} microlamports`);
          console.log(`[Broadcast] NOTE: Priority fee bump requires rebuilding transaction - not implemented`);
          console.log(`[Broadcast] Retrying with original transaction...`);
          // NOTE: Full implementation would rebuild instructions with new CU price
          currentCuPrice = newPrice;
          continue;
        }
      }
      
      // No retry condition met or max attempts reached
      break;
    }
  }
  
  return attempts;
}

/**
 * Format attempt results for logging
 */
export function formatAttemptResults(attempts: SendAttemptResult[]): string {
  let output = `\n[Broadcast] Total attempts: ${attempts.length}\n`;
  
  for (const attempt of attempts) {
    output += `\n  Attempt ${attempt.attemptNumber}:\n`;
    output += `    Success: ${attempt.success}\n`;
    if (attempt.signature) output += `    Signature: ${attempt.signature}\n`;
    if (attempt.slot) output += `    Slot: ${attempt.slot}\n`;
    if (attempt.timingMs) output += `    Timing: ${attempt.timingMs}ms\n`;
    if (attempt.failureType) output += `    Failure Type: ${attempt.failureType}\n`;
    if (attempt.error) output += `    Error: ${attempt.error}\n`;
  }
  
  const finalAttempt = attempts[attempts.length - 1];
  if (finalAttempt) {
    output += `\n  Final Result: ${finalAttempt.success ? 'SUCCESS' : 'FAILURE'}\n`;
  }
  
  return output;
}
