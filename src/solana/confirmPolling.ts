import { Connection, SignatureStatus, TransactionError } from '@solana/web3.js';

/**
 * Configuration for HTTP-based signature polling
 */
export interface ConfirmPollingConfig {
  /** Polling interval in milliseconds (default: 500) */
  intervalMs?: number;
  /** Timeout in milliseconds (default: 60000 = 60 seconds) */
  timeoutMs?: number;
  /** Commitment level to check (default: "confirmed") */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/** Default polling interval in milliseconds */
export const DEFAULT_POLL_INTERVAL_MS = 500;

/** Default timeout in milliseconds (60 seconds) */
export const DEFAULT_POLL_TIMEOUT_MS = 60_000;

/** Number of characters to display from signature in logs */
const SIGNATURE_DISPLAY_LENGTH = 12;

/** Log polling status every N polls to reduce verbosity */
const LOG_FREQUENCY = 10;

/**
 * Result of signature confirmation polling
 */
export interface ConfirmPollingResult {
  success: boolean;
  signature: string;
  status?: SignatureStatus;
  error?: TransactionError;
  logs?: string[];
  timedOut?: boolean;
  pollCount?: number;
  durationMs?: number;
}

/**
 * Confirm transaction signature via HTTP polling (no websocket subscriptions).
 * 
 * Polls connection.getSignatureStatuses() until signature is confirmed/finalized
 * or until timeout is reached. Avoids websocket-based confirmTransaction() which
 * can cause JSON-RPC errors on providers without WS support.
 * 
 * Success criteria:
 * - status.confirmationStatus is "confirmed" or "finalized"
 * - status.err is null
 * 
 * Failure criteria:
 * - status.err is non-null (immediate failure)
 * - Timeout reached without confirmation
 * 
 * @param connection - Solana connection
 * @param signature - Transaction signature to confirm
 * @param config - Polling configuration
 * @returns Confirmation result with status and logs
 */
export async function confirmSignatureByPolling(
  connection: Connection,
  signature: string,
  config: ConfirmPollingConfig = {}
): Promise<ConfirmPollingResult> {
  const intervalMs = config.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const commitment = config.commitment ?? 'confirmed';
  
  console.log(`[Confirm] Polling signature ${signature.slice(0, SIGNATURE_DISPLAY_LENGTH)}... (commitment=${commitment}, timeout=${timeoutMs}ms)`);
  
  const startTime = Date.now();
  let pollCount = 0;
  
  while (true) {
    pollCount++;
    const elapsed = Date.now() - startTime;
    
    // Check timeout
    if (elapsed >= timeoutMs) {
      console.error(`[Confirm] ❌ Timeout after ${elapsed}ms (${pollCount} polls)`);
      return {
        success: false,
        signature,
        timedOut: true,
        pollCount,
        durationMs: elapsed,
      };
    }
    
    try {
      // Poll signature status
      const response = await connection.getSignatureStatuses([signature]);
      const status = response.value[0];
      
      // Log poll result for debugging
      if (pollCount === 1 || pollCount % LOG_FREQUENCY === 0) {
        console.log(`[Confirm] Poll #${pollCount}: ${status ? `status=${status.confirmationStatus}, err=${status.err ? 'present' : 'null'}` : 'not found yet'}`);
      }
      
      // Status not found yet - continue polling
      if (!status) {
        await sleep(intervalMs);
        continue;
      }
      
      // Check for transaction error
      if (status.err) {
        console.error(`[Confirm] ❌ Transaction failed with error:`, status.err);
        
        // Try to fetch logs for additional context
        // Note: Always use 'confirmed' commitment for log retrieval to ensure logs are available
        // Using lower commitment levels (like 'processed') may result in logs not being ready yet
        let logs: string[] | undefined;
        try {
          const txResponse = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
          logs = txResponse?.meta?.logMessages ?? undefined;
        } catch (logErr) {
          console.warn(`[Confirm] Could not fetch logs:`, logErr instanceof Error ? logErr.message : String(logErr));
        }
        
        return {
          success: false,
          signature,
          status,
          error: status.err,
          logs,
          pollCount,
          durationMs: Date.now() - startTime,
        };
      }
      
      // Check confirmation status
      const confirmationStatus = status.confirmationStatus;
      
      // Success: confirmed or finalized
      if (confirmationStatus === 'confirmed' || confirmationStatus === 'finalized') {
        const durationMs = Date.now() - startTime;
        console.log(`[Confirm] ✅ Transaction ${confirmationStatus} in ${durationMs}ms (${pollCount} polls)`);
        
        return {
          success: true,
          signature,
          status,
          pollCount,
          durationMs,
        };
      }
      
      // Status is "processed" - continue polling for higher commitment
      if (confirmationStatus === 'processed') {
        console.log(`[Confirm] Status: processed (waiting for ${commitment}...)`);
        await sleep(intervalMs);
        continue;
      }
      
      // Unknown status - log and continue
      console.warn(`[Confirm] Unexpected confirmation status: ${confirmationStatus}`);
      await sleep(intervalMs);
      continue;
      
    } catch (err) {
      // Network error during polling - log and retry
      console.warn(`[Confirm] Poll error (will retry):`, err instanceof Error ? err.message : String(err));
      await sleep(intervalMs);
      continue;
    }
  }
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
