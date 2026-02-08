import fs from 'node:fs';
import path from 'node:path';
import { loadStartupSchedulerConfig } from './config/startupSchedulerConfig.js';
import { loadEnv } from '../config/env.js';
import { refreshQueue, loadQueue } from './txScheduler.js';
import { type TtlManagerParams } from '../predict/forecastTTLManager.js';
import { runDryExecutor } from '../execute/executor.js';
import { YellowstoneAccountListener } from '../monitoring/yellowstoneAccountListener.js';
import { YellowstonePriceListener } from '../monitoring/yellowstonePriceListener.js';
import { EventRefreshOrchestrator } from '../monitoring/eventRefreshOrchestrator.js';

function getEnvNum(key: string, def: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

function loadCandidateSource(): any[] {
  const candidatesPath = path.join(process.cwd(), 'data', 'candidates.json');
  if (!fs.existsSync(candidatesPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.candidates)) return raw.candidates;
    return Object.values(raw);
  } catch {
    return [];
  }
}

// Initialize listeners and orchestrator for event-driven refresh
async function initRealtime(): Promise<EventRefreshOrchestrator> {
  const grpcEndpoint = process.env.YELLOWSTONE_GRPC_URL || '';
  const obligationPubkeys = (process.env.OBLIGATION_PUBKEYS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const assetMints = (process.env.PRICE_ASSET_MINTS ?? '').split(',').map(s => s.trim()).filter(Boolean);

  const accountListener = new YellowstoneAccountListener({ grpcEndpoint, obligationPubkeys, reconnectMs: 5000 });
  const priceListener = new YellowstonePriceListener({ grpcEndpoint, assetMints, reconnectMs: 5000 });
  const orchestrator = new EventRefreshOrchestrator({
    minPricePctChange: parseFloat(process.env.MIN_PRICE_PCT_CHANGE || '1.0'),
    minHealthDelta: parseFloat(process.env.MIN_HEALTH_DELTA || '0.01'),
    minRefreshIntervalMs: parseInt(process.env.EVENT_MIN_REFRESH_INTERVAL_MS || '3000', 10),
  });

  accountListener.on('ready', info => console.log(`[Realtime] Account listener ready:`, info));
  accountListener.on('account-update', ev => orchestrator.handleAccountUpdate(ev));

  priceListener.on('ready', info => console.log(`[Realtime] Price listener ready:`, info));
  priceListener.on('price-update', ev => orchestrator.handlePriceUpdate(ev));

  await accountListener.start();
  await priceListener.start();

  return orchestrator;
}

export async function startBotStartupScheduler(): Promise<void> {
  // Ensure env is loaded so scheduler flags are present
  loadEnv();
  const cfg = loadStartupSchedulerConfig();

  const ttlParams: TtlManagerParams = {
    forecastMaxAgeMs: getEnvNum('FORECAST_MAX_AGE_MS', 300_000),
    minRefreshIntervalMs: getEnvNum('SCHED_MIN_REFRESH_INTERVAL_MS', 60_000),
    ttlExpiredMarginMin: getEnvNum('SCHED_TTL_EXPIRED_MARGIN_MIN', 2),
    evDropPct: getEnvNum('SCHED_EV_DROP_PCT', 0.15),
    minEv: getEnvNum('SCHED_MIN_EV', 0),
  };

  const candidateSource = loadCandidateSource();

  // Initialize event-driven refresh
  const orchestrator = await initRealtime();

  async function cycleOnce(): Promise<void> {
    console.log('\n[Scheduler] Cycle start');

    // Optional: keep a very infrequent periodic refresh as safety (disabled by default)
    if ((process.env.SCHEDULER_ENABLE_REFRESH ?? 'false') === 'true') {
      const updated = refreshQueue(ttlParams, candidateSource);
      console.log(`[Scheduler] Refresh complete: queue size ${updated.length}`);
    } else {
      console.log('[Scheduler] Event-driven refresh enabled (cron refresh disabled).');
    }

    if ((process.env.SCHEDULER_ENABLE_AUDIT ?? 'true') === 'true') {
      const queue = loadQueue();
      const total = queue.length;
      const active = queue.filter(p => Number(p.ttlMin ?? Infinity) > 0).length;
      const expired = total - active;
      console.log(`[Audit] Total: ${total} | Active: ${active} | Expired: ${expired}`);
      if (total > 0) {
        const top = [...queue]
          .sort((a, b) =>
            (Number(b.ev) - Number(a.ev)) ||
            (Number(a.ttlMin) - Number(b.ttlMin)) ||
            (Number(b.hazard) - Number(a.hazard))
          )
          .slice(0, 5)
          .map(p => ({ key: p.key, ev: Number(p.ev).toFixed(2), ttlMin: Number(p.ttlMin).toFixed(2), hazard: Number(p.hazard).toFixed(3) }));
        console.table(top);
      }
    }

    if ((process.env.SCHEDULER_ENABLE_DRYRUN ?? 'true') === 'true') {
      try {
        const res = await runDryExecutor({ dry: true });
        console.log('[Executor] Dry-run completed:', res?.status ?? 'ok');
      } catch (e) {
        console.warn('[Executor] Dry-run failed:', (e as Error).message);
      }
    }

    console.log('[Scheduler] Cycle end');
  }

  // Run initial cycle; rely on event-driven triggers afterwards
  await cycleOnce();

  // Keep a very slow heartbeat cycle for audit/logging (optional)
  const heartbeatMs = parseInt(process.env.SCHED_HEARTBEAT_INTERVAL_MS || '60000', 10);
  setInterval(() => {
    cycleOnce().catch(err => console.error('[Scheduler] Cycle error:', err));
  }, heartbeatMs);
}

// CLI entry
(async () => {
  await startBotStartupScheduler();
})();
