import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitBotEvent, loadBotMetricsSummary } from '../observability/botTelemetry.js';

describe('bot telemetry', () => {
  let metricsDir = '';

  beforeEach(() => {
    metricsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liqsol-metrics-'));
    process.env.METRICS_ENABLED = 'true';
    process.env.METRICS_DIR = metricsDir;
  });

  afterEach(() => {
    fs.rmSync(metricsDir, { recursive: true, force: true });
  });

  it('queue-refresh-summary updates queue metrics correctly', async () => {
    await emitBotEvent({
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'queue-refresh-summary',
      candidateCount: 11,
      filteredCount: 7,
      validPlanCount: 5,
      queueSize: 4,
      reasons: { evTooLow: 3 },
    });

    const summary = await loadBotMetricsSummary();
    expect(summary.queue.refreshCount).toBe(1);
    expect(summary.queue.lastCandidateCount).toBe(11);
    expect(summary.queue.lastFilteredCount).toBe(7);
    expect(summary.queue.lastValidPlanCount).toBe(5);
    expect(summary.queue.lastQueueSize).toBe(4);
    expect(summary.queue.queueHighWaterMark).toBe(4);
    expect(summary.queue.lastReasons).toEqual({ evTooLow: 3 });
  });

  it('queue-opportunity-added increments totals', async () => {
    await emitBotEvent({ ts: new Date().toISOString(), kind: 'queue-opportunity-added' });
    await emitBotEvent({ ts: new Date().toISOString(), kind: 'queue-opportunity-added' });
    const summary = await loadBotMetricsSummary();
    expect(summary.queue.totalOpportunitiesAdded).toBe(2);
  });

  it('execution-attempt-result confirmed updates status, broadcast counts, and pnl sums', async () => {
    await emitBotEvent({
      ts: new Date().toISOString(),
      kind: 'execution-attempt-result',
      status: 'confirmed',
      broadcast: true,
      estimatedProfitUsd: 10,
      estimatedCostUsd: 2,
      estimatedNetUsd: 8,
      expectedValueUsd: 9,
      chainFeeLamports: 5000,
    });
    const summary = await loadBotMetricsSummary();
    expect(summary.execution.resultsByStatus.confirmed).toBe(1);
    expect(summary.execution.broadcastConfirmed).toBe(1);
    expect(summary.pnl.confirmedCount).toBe(1);
    expect(summary.pnl.estimatedProfitUsdConfirmedSum).toBe(10);
    expect(summary.pnl.estimatedCostUsdConfirmedSum).toBe(2);
    expect(summary.pnl.estimatedNetUsdConfirmedSum).toBe(8);
    expect(summary.pnl.expectedValueUsdConfirmedSum).toBe(9);
    expect(summary.pnl.chainFeeLamportsConfirmedSum).toBe(5000);
  });

  it('failure status increments resultsByStatus and broadcastFailed', async () => {
    await emitBotEvent({
      ts: new Date().toISOString(),
      kind: 'execution-attempt-result',
      status: 'sim-error',
      broadcast: true,
    });
    const summary = await loadBotMetricsSummary();
    expect(summary.execution.resultsByStatus['sim-error']).toBe(1);
    expect(summary.execution.broadcastFailed).toBe(1);
  });

  it('appends event journal and atomically updates summary', async () => {
    await emitBotEvent({
      ts: new Date().toISOString(),
      kind: 'execution-attempt-started',
      planKey: 'plan-1',
    });
    const eventsPath = path.join(metricsDir, 'events.jsonl');
    const summaryPath = path.join(metricsDir, 'summary.json');
    expect(fs.existsSync(eventsPath)).toBe(true);
    expect(fs.existsSync(summaryPath)).toBe(true);
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
      execution: { attemptsStarted: number; lastPlanKey?: string };
    };
    expect(summary.execution.attemptsStarted).toBe(1);
    expect(summary.execution.lastPlanKey).toBe('plan-1');
  });
});
