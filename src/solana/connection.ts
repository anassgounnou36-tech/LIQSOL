import { Connection } from '@solana/web3.js';
import { config as dotenvConfig } from 'dotenv';

/**
 * Centralized Solana Connection singleton.
 * 
 * This module provides a single shared web3.js Connection instance
 * to prevent RPC mismatch issues with Kamino SDK's @solana/kit RPC.
 * 
 * IMPORTANT: Never call kaminoMarket.getRpc().getAccountInfo() or similar.
 * The Kamino SDK RPC uses @solana/kit which doesn't expose web3.js Connection methods.
 * Always use this module's getConnection() for generic Solana RPC calls.
 */

let connectionInstance: Connection | null = null;

/**
 * Get or create the shared Connection instance.
 * Initializes from RPC_PRIMARY environment variable on first call.
 * Uses 'confirmed' commitment level by default.
 * 
 * @returns Shared Connection instance for all RPC operations
 */
export function getConnection(): Connection {
  if (!connectionInstance) {
    // Load .env if not already loaded
    if (!process.env.RPC_PRIMARY) {
      dotenvConfig();
    }
    
    const rpcUrl = process.env.RPC_PRIMARY;
    if (!rpcUrl) {
      throw new Error(
        'RPC_PRIMARY environment variable is required. ' +
        'Please ensure .env file exists with RPC_PRIMARY set.'
      );
    }
    
    // Use 'confirmed' as default commitment level for balance between speed and reliability
    connectionInstance = new Connection(rpcUrl, 'confirmed');
    console.log(`[Connection] Initialized shared Connection to ${rpcUrl} with 'confirmed' commitment`);
  }
  
  return connectionInstance;
}

/**
 * Reset the connection singleton (primarily for testing).
 * Forces reinitialization on next getConnection() call.
 */
export function resetConnection(): void {
  connectionInstance = null;
}
