import { PublicKey } from '@solana/web3.js';
import { loadEnv } from '../config/env.js';
import { loadStartupSchedulerConfig } from './config/startupSchedulerConfig.js';
import { RuntimeCoordinator } from '../live/runtimeCoordinator.js';
import { loadLiveRuntimeConfig } from '../live/runtimeConfig.js';

let runtimeCoordinator: RuntimeCoordinator | null = null;
let startupPromise: Promise<void> | null = null;

function getCoordinator(): RuntimeCoordinator {
  if (runtimeCoordinator) return runtimeCoordinator;
  const env = loadEnv();
  const runtimeConfig = loadLiveRuntimeConfig();
  runtimeCoordinator = new RuntimeCoordinator(
    {
      marketPubkey: new PublicKey(env.KAMINO_MARKET_PUBKEY),
      programId: new PublicKey(env.KAMINO_KLEND_PROGRAM_ID),
      execAllowlistMints:
        process.env.LIQSOL_EXEC_MINT_ALLOWLIST?.split(',').map(v => v.trim()).filter(Boolean) ??
        process.env.LIQSOL_LIQ_MINT_ALLOWLIST?.split(',').map(v => v.trim()).filter(Boolean),
    },
    {
      rebuildIntervalMs: runtimeConfig.rebuildIntervalMs,
      heartbeatIntervalMs: runtimeConfig.heartbeatIntervalMs,
      tickDebounceMs: runtimeConfig.tickDebounceMs,
      queueEmptyLogIntervalMs: runtimeConfig.queueEmptyLogIntervalMs,
      promotionSummaryLogIntervalMs: runtimeConfig.promotionSummaryLogIntervalMs,
      realtimeEnabled: runtimeConfig.realtimeEnabled,
    },
  );
  return runtimeCoordinator;
}

export async function startBotStartupScheduler(): Promise<void> {
  loadEnv();
  loadStartupSchedulerConfig();
  if (startupPromise) {
    await startupPromise;
    return;
  }
  startupPromise = getCoordinator().start({
    broadcast: (process.env.LIQSOL_BROADCAST === 'true') || (process.env.EXECUTOR_BROADCAST === 'true'),
  }).finally(() => {
    startupPromise = null;
  });
  await startupPromise;
}

export async function reloadRealtimeWatchTargets(): Promise<void> {
  await getCoordinator().reloadWatchTargets('manual-reload');
}

export async function reloadWatchlistFromQueue(): Promise<void> {
  await reloadRealtimeWatchTargets();
}
