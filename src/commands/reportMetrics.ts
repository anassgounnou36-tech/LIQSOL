import fs from 'node:fs';
import path from 'node:path';
import { loadBotMetricsSummary } from '../observability/botTelemetry.js';

function getMetricsDir(): string {
  return path.resolve(process.env.METRICS_DIR ?? 'data/metrics');
}

function loadRecentEvents(limit: number): unknown[] {
  const eventsPath = path.join(getMetricsDir(), 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  const raw = fs.readFileSync(eventsPath, 'utf8').trim();
  if (!raw) return [];
  return raw
    .split('\n')
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: true, raw: line };
      }
    });
}

async function main() {
  const asJson = process.argv.includes('--json');
  const summary = await loadBotMetricsSummary();
  const recentEvents = loadRecentEvents(20);
  const payload = { summary, recentEvents };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('=== LIQSOL Metrics Summary ===');
  console.log(`Updated: ${summary.updatedAt}`);
  console.log(
    `Queue: refreshes=${summary.queue.refreshCount} size=${summary.queue.lastQueueSize} highWater=${summary.queue.queueHighWaterMark} added=${summary.queue.totalOpportunitiesAdded}`,
  );
  console.log(
    `Execution: started=${summary.execution.attemptsStarted} confirmed=${summary.execution.broadcastConfirmed} failed=${summary.execution.broadcastFailed} last=${summary.execution.lastStatus ?? 'n/a'}`,
  );
  console.log(
    `PnL(est): confirmed=${summary.pnl.confirmedCount} profit=${summary.pnl.estimatedProfitUsdConfirmedSum.toFixed(2)} cost=${summary.pnl.estimatedCostUsdConfirmedSum.toFixed(2)} net=${summary.pnl.estimatedNetUsdConfirmedSum.toFixed(2)} feeLamports=${summary.pnl.chainFeeLamportsConfirmedSum}`,
  );
  console.log(
    `Telegram: sent=${summary.telegram.sentCount} failed=${summary.telegram.failedCount} lastSent=${summary.telegram.lastSentAt ?? 'n/a'}`,
  );
  if (summary.telegram.lastError) {
    console.log(`Telegram last error: ${summary.telegram.lastError}`);
  }
  console.log('\nRecent events (last 20):');
  if (recentEvents.length === 0) {
    console.log('(none)');
    return;
  }
  for (const event of recentEvents) {
    const e = event as { ts?: string; kind?: string; status?: string; planKey?: string };
    console.log(
      `- ${e.ts ?? 'n/a'} | ${e.kind ?? 'unknown'} | ${e.status ?? ''} ${e.planKey ? `| ${e.planKey}` : ''}`.trim(),
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
