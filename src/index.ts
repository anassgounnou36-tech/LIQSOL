import { Connection, Keypair } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { env } from './config/env.js';
import { logger } from './observability/logger.js';

async function main() {
  // Initialize connection
  const connection = new Connection(env.RPC_URL, 'confirmed');

  // Load bot keypair
  const keypairData = JSON.parse(readFileSync(env.BOT_KEYPAIR_PATH, 'utf-8'));
  const botKeypair = Keypair.fromSecretKey(new Uint8Array(keypairData));

  // Boot checks
  const startTime = Date.now();
  const slot = await connection.getSlot();
  const latencyMs = Date.now() - startTime;

  // Log boot success
  logger.info({
    event: 'boot_ok',
    rpc_url: env.RPC_URL,
    rpc_latency_ms: latencyMs,
    current_slot: slot,
    bot_pubkey: botKeypair.publicKey.toBase58(),
    node_env: env.NODE_ENV,
  });

  // Additional startup logic would go here
}

main().catch((error) => {
  logger.fatal({
    event: 'boot_failed',
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});
