import { loadEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { ConnectionManager } from "../infra/connectionManager.js";
import { BlockhashManager } from "../infra/blockhashManager.js";
import { WebsocketManager } from "../infra/websocketManager.js";

const WS_POLL_INTERVAL_MS = 100;
const WS_TIMEOUT_MS = 10000;

async function main() {
  const env = loadEnv();

  logger.info({ event: "healthcheck_start" }, "starting healthcheck");

  // Test RPC connections
  const connMgr = new ConnectionManager(env.RPC_PRIMARY, env.RPC_SECONDARY);
  await connMgr.refreshLatencies();
  logger.info(
    { 
      event: "rpc_latencies_checked",
      primary: connMgr.primary.rpcEndpoint,
      secondary: connMgr.secondary?.rpcEndpoint
    },
    "rpc connections checked"
  );

  // Test blockhash retrieval
  const bhMgr = new BlockhashManager(connMgr.getConnection());
  const { blockhash, lastValidBlockHeight } = await bhMgr.getFresh();
  logger.info(
    { 
      event: "blockhash_retrieved",
      blockhash: blockhash.substring(0, 8) + "...",
      lastValidBlockHeight
    },
    "blockhash retrieved"
  );

  // Test websocket if configured
  if (env.WS_PRIMARY) {
    logger.info({ event: "ws_check_start", ws: env.WS_PRIMARY }, "checking websocket");
    
    const wsMgr = new WebsocketManager(env.WS_PRIMARY);
    let slotUpdateReceived = false;

    try {
      await wsMgr.connect();
      
      // Subscribe to slot updates
      wsMgr.subscribeSlot((slot) => {
        logger.debug({ event: "ws_slot_update", slot }, "received slot update");
        slotUpdateReceived = true;
      });

      // Wait for at least one slot update (with timeout)
      await new Promise<void>((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (slotUpdateReceived) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, WS_POLL_INTERVAL_MS);

        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error(`No slot updates received within ${WS_TIMEOUT_MS / 1000} seconds`));
        }, WS_TIMEOUT_MS);
      });

      logger.info({ event: "ws_check_ok" }, "websocket check passed");
      wsMgr.close();
    } catch (err) {
      logger.fatal({ event: "ws_check_failed", err }, "websocket check failed");
      wsMgr.close();
      process.exit(1);
    }
  }

  logger.info({ event: "healthcheck_ok" }, "healthcheck passed");
}

main().catch((err) => {
  logger.fatal({ event: "healthcheck_failed", err }, "healthcheck failed");
  process.exit(1);
});
