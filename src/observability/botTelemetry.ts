import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../shared/fs.js';
import { logger } from './logger.js';

export type BotEventKind =
  | 'queue-refresh-summary'
  | 'queue-opportunity-added'
  | 'execution-attempt-started'
  | 'execution-attempt-result';

export interface BotEvent {
  ts: string;
  kind: BotEventKind;
  planKey?: string;
  obligationPubkey?: string;
  ownerPubkey?: string;
  repayMint?: string;
  collateralMint?: string;
  ev?: number | null;
  ttlMin?: number | null;
  ttlStr?: string | null;
  hazard?: number | null;
  signature?: string;
  slot?: number;
  status?: string;
  broadcast?: boolean;
  dry?: boolean;
  queueSize?: number;
  candidateCount?: number;
  filteredCount?: number;
  validPlanCount?: number;
  reasons?: Record<string, number>;
  estimatedProfitUsd?: number | null;
  estimatedCostUsd?: number | null;
  estimatedNetUsd?: number | null;
  expectedValueUsd?: number | null;
  chainFeeLamports?: number | null;
  note?: string;
}

export interface BotMetricsSummary {
  version: 1;
  updatedAt: string;
  queue: {
    refreshCount: number;
    lastCandidateCount: number;
    lastFilteredCount: number;
    lastValidPlanCount: number;
    lastQueueSize: number;
    queueHighWaterMark: number;
    totalOpportunitiesAdded: number;
    lastReasons: Record<string, number>;
  };
  execution: {
    attemptsStarted: number;
    resultsByStatus: Record<string, number>;
    broadcastConfirmed: number;
    broadcastFailed: number;
    lastStatus?: string;
    lastSignature?: string;
    lastSlot?: number;
    lastPlanKey?: string;
  };
  pnl: {
    confirmedCount: number;
    estimatedProfitUsdConfirmedSum: number;
    estimatedCostUsdConfirmedSum: number;
    estimatedNetUsdConfirmedSum: number;
    expectedValueUsdConfirmedSum: number;
    chainFeeLamportsConfirmedSum: number;
  };
  telegram: {
    sentCount: number;
    failedCount: number;
    lastSentAt?: string;
    lastError?: string;
  };
}

const SUCCESS_STATUSES = new Set(['confirmed', 'atomic-sent', 'setup-completed']);
const FAILURE_STATUSES = new Set([
  'sim-error',
  'build-failed',
  'tx-too-large',
  'setup-failed',
  'atomic-preflight-failed',
  'compiled-validation-failed',
]);

function getMetricsEnabled(): boolean {
  return (process.env.METRICS_ENABLED ?? 'true') === 'true';
}

function getMetricsDir(): string {
  return path.resolve(process.env.METRICS_DIR ?? 'data/metrics');
}

function getMetricsPaths() {
  const metricsDir = getMetricsDir();
  return {
    eventsPath: path.join(metricsDir, 'events.jsonl'),
    summaryPath: path.join(metricsDir, 'summary.json'),
  };
}

function createEmptySummary(nowIso = new Date().toISOString()): BotMetricsSummary {
  return {
    version: 1,
    updatedAt: nowIso,
    queue: {
      refreshCount: 0,
      lastCandidateCount: 0,
      lastFilteredCount: 0,
      lastValidPlanCount: 0,
      lastQueueSize: 0,
      queueHighWaterMark: 0,
      totalOpportunitiesAdded: 0,
      lastReasons: {},
    },
    execution: {
      attemptsStarted: 0,
      resultsByStatus: {},
      broadcastConfirmed: 0,
      broadcastFailed: 0,
    },
    pnl: {
      confirmedCount: 0,
      estimatedProfitUsdConfirmedSum: 0,
      estimatedCostUsdConfirmedSum: 0,
      estimatedNetUsdConfirmedSum: 0,
      expectedValueUsdConfirmedSum: 0,
      chainFeeLamportsConfirmedSum: 0,
    },
    telegram: {
      sentCount: 0,
      failedCount: 0,
    },
  };
}

function toFiniteNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function safeEvent(event: BotEvent): BotEvent {
  return {
    ...event,
    ts: event.ts || new Date().toISOString(),
  };
}

function applyEvent(summary: BotMetricsSummary, event: BotEvent): void {
  summary.updatedAt = event.ts;
  if (event.kind === 'queue-refresh-summary') {
    summary.queue.refreshCount += 1;
    summary.queue.lastCandidateCount = event.candidateCount ?? 0;
    summary.queue.lastFilteredCount = event.filteredCount ?? 0;
    summary.queue.lastValidPlanCount = event.validPlanCount ?? 0;
    summary.queue.lastQueueSize = event.queueSize ?? 0;
    summary.queue.lastReasons = event.reasons ?? {};
    summary.queue.queueHighWaterMark = Math.max(
      summary.queue.queueHighWaterMark,
      summary.queue.lastQueueSize,
    );
    return;
  }

  if (event.kind === 'queue-opportunity-added') {
    summary.queue.totalOpportunitiesAdded += 1;
    return;
  }

  if (event.kind === 'execution-attempt-started') {
    summary.execution.attemptsStarted += 1;
    summary.execution.lastPlanKey = event.planKey;
    return;
  }

  if (event.kind === 'execution-attempt-result') {
    const status = event.status ?? 'unknown';
    summary.execution.resultsByStatus[status] =
      (summary.execution.resultsByStatus[status] ?? 0) + 1;
    summary.execution.lastStatus = status;
    summary.execution.lastPlanKey = event.planKey;
    summary.execution.lastSignature = event.signature;
    summary.execution.lastSlot = event.slot;

    if (event.broadcast === true && SUCCESS_STATUSES.has(status)) {
      summary.execution.broadcastConfirmed += 1;
      summary.pnl.confirmedCount += 1;
      summary.pnl.estimatedProfitUsdConfirmedSum += toFiniteNumber(event.estimatedProfitUsd);
      summary.pnl.estimatedCostUsdConfirmedSum += toFiniteNumber(event.estimatedCostUsd);
      summary.pnl.estimatedNetUsdConfirmedSum += toFiniteNumber(event.estimatedNetUsd);
      summary.pnl.expectedValueUsdConfirmedSum += toFiniteNumber(event.expectedValueUsd);
      summary.pnl.chainFeeLamportsConfirmedSum += toFiniteNumber(event.chainFeeLamports);
    }

    if (event.broadcast === true && FAILURE_STATUSES.has(status)) {
      summary.execution.broadcastFailed += 1;
    }
  }
}

export async function loadBotMetricsSummary(): Promise<BotMetricsSummary> {
  if (!getMetricsEnabled()) {
    return createEmptySummary();
  }

  const { summaryPath } = getMetricsPaths();
  if (!fs.existsSync(summaryPath)) {
    return createEmptySummary();
  }
  try {
    const parsed = JSON.parse(await fs.promises.readFile(summaryPath, 'utf8')) as BotMetricsSummary;
    return {
      ...createEmptySummary(),
      ...parsed,
      queue: { ...createEmptySummary().queue, ...(parsed.queue ?? {}) },
      execution: { ...createEmptySummary().execution, ...(parsed.execution ?? {}) },
      pnl: { ...createEmptySummary().pnl, ...(parsed.pnl ?? {}) },
      telegram: { ...createEmptySummary().telegram, ...(parsed.telegram ?? {}) },
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), summaryPath },
      'Failed to load metrics summary, resetting defaults',
    );
    return createEmptySummary();
  }
}

export async function emitBotEvent(event: BotEvent): Promise<void> {
  if (!getMetricsEnabled()) return;

  const normalized = safeEvent(event);
  const { eventsPath, summaryPath } = getMetricsPaths();
  try {
    await fs.promises.mkdir(path.dirname(eventsPath), { recursive: true });
    await fs.promises.appendFile(eventsPath, `${JSON.stringify(normalized)}\n`, 'utf8');
    const summary = await loadBotMetricsSummary();
    applyEvent(summary, normalized);
    await writeJsonAtomic(summaryPath, summary);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), kind: normalized.kind },
      'Failed to persist bot telemetry event',
    );
  }
}

export async function recordTelegramSendResult(args: {
  ok: boolean;
  error?: string;
}): Promise<void> {
  if (!getMetricsEnabled()) return;

  const { summaryPath } = getMetricsPaths();
  try {
    const nowIso = new Date().toISOString();
    const summary = await loadBotMetricsSummary();
    summary.updatedAt = nowIso;
    if (args.ok) {
      summary.telegram.sentCount += 1;
      summary.telegram.lastSentAt = nowIso;
      if (!args.error) {
        delete summary.telegram.lastError;
      }
    } else {
      summary.telegram.failedCount += 1;
      summary.telegram.lastError = args.error ?? 'unknown error';
    }
    await writeJsonAtomic(summaryPath, summary);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to persist telegram send metrics',
    );
  }
}

export function makePlanFingerprint(plan: {
  key: string;
  predictedLiquidationAtMs?: number | string | null;
  ttlComputedAtMs?: number | string | null;
  createdAtMs?: number | string | null;
  repayMint?: string;
  collateralMint?: string;
}): string {
  return [
    plan.key,
    plan.predictedLiquidationAtMs ?? '',
    plan.ttlComputedAtMs ?? '',
    plan.createdAtMs ?? '',
    plan.repayMint ?? '',
    plan.collateralMint ?? '',
  ].join('|');
}
