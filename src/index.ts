import { Keypair } from "@solana/web3.js";
import fs from "node:fs";
import { getConnection } from "./solana/connection.js";
import { loadEnv } from "./config/env.js";
import { logger } from "./observability/logger.js";

function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("Keypair file must be a JSON array");
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

async function main() {
  const env = loadEnv();

  const conn = getConnection();
  const kp = loadKeypair(env.BOT_KEYPAIR_PATH);

  const t0 = Date.now();
  const slot = await conn.getSlot("processed");
  const latencyMs = Date.now() - t0;

  logger.info(
    { event: "boot_ok", slot, rpc: env.RPC_PRIMARY, rpc_latency_ms: latencyMs, bot_pubkey: kp.publicKey.toBase58() },
    "boot_ok"
  );
}

main().catch((err) => {
  logger.fatal({ event: "boot_failed", err }, "boot_failed");
  process.exit(1);
});