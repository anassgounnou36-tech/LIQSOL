import type { BotEvent } from '../observability/botTelemetry.js';
import { recordTelegramSendResult } from '../observability/botTelemetry.js';
import { logger } from '../observability/logger.js';
import { escapeTelegramHtml, sendTelegramMessage } from './telegram.js';

const SUCCESS_STATUSES = new Set(['confirmed', 'atomic-sent', 'setup-completed']);
const FAILURE_STATUSES = new Set([
  'sim-error',
  'build-failed',
  'tx-too-large',
  'setup-failed',
  'atomic-preflight-failed',
  'compiled-validation-failed',
  'blocked-insufficient-rent',
]);

function enabled(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  return raw === 'true';
}

function getNum(key: string, fallback: number): number {
  const num = Number(process.env[key]);
  return Number.isFinite(num) ? num : fallback;
}

function shortPlanKey(planKey?: string): string {
  if (!planKey) return 'unknown';
  return planKey.length <= 12 ? planKey : `${planKey.slice(0, 12)}…`;
}

function fmtUsd(value?: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  return `$${Number(value).toFixed(2)}`;
}

function fmtNum(value?: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  return Number(value).toFixed(4);
}

function fmtLine(label: string, value: string): string {
  return `${label} ${escapeTelegramHtml(value)}`;
}

function shouldNotify(event: BotEvent): boolean {
  if (!enabled('TELEGRAM_ENABLED', false)) return false;

  if (event.kind === 'queue-opportunity-added') {
    if (!enabled('TELEGRAM_NOTIFY_QUEUE_ADDED', true)) return false;
    if (event.ev === null || event.ev === undefined) return false;
    return Number(event.ev) >= getNum('TELEGRAM_NOTIFY_MIN_EV', 0);
  }

  if (event.kind === 'execution-attempt-started') {
    return enabled('TELEGRAM_NOTIFY_EXECUTION_STARTED', true) && event.broadcast === true;
  }

  if (event.kind === 'execution-attempt-result') {
    const status = event.status ?? '';
    if (SUCCESS_STATUSES.has(status)) {
      return enabled('TELEGRAM_NOTIFY_EXECUTION_RESULTS', true);
    }
    if (FAILURE_STATUSES.has(status)) {
      return enabled('TELEGRAM_NOTIFY_FAILURES', true);
    }
    return false;
  }

  return false;
}

function buildMessage(event: BotEvent): string {
  if (event.kind === 'queue-opportunity-added') {
    return [
      '🟢 <b>LIQSOL opportunity added</b>',
      fmtLine('Plan:', shortPlanKey(event.planKey)),
      fmtLine('EV:', fmtUsd(event.ev)),
      fmtLine('TTL:', event.ttlStr ?? 'unknown'),
      fmtLine('Hazard:', fmtNum(event.hazard)),
      fmtLine(
        'Repay/Collateral:',
        `${event.repayMint ?? 'unknown'} -> ${event.collateralMint ?? 'unknown'}`,
      ),
      fmtLine('Estimated net:', fmtUsd(event.estimatedNetUsd)),
      fmtLine('Queue size:', String(event.queueSize ?? 0)),
    ].join('\n');
  }

  if (event.kind === 'execution-attempt-started') {
    return [
      '🚀 <b>LIQSOL execution started</b>',
      fmtLine('Plan:', shortPlanKey(event.planKey)),
      fmtLine('EV:', fmtUsd(event.ev)),
      fmtLine('TTL:', event.ttlStr ?? 'unknown'),
      fmtLine(
        'Repay/Collateral:',
        `${event.repayMint ?? 'unknown'} -> ${event.collateralMint ?? 'unknown'}`,
      ),
      'Mode: broadcast',
    ].join('\n');
  }

  const status = event.status ?? 'unknown';
  if (SUCCESS_STATUSES.has(status)) {
    return [
      '✅ <b>LIQSOL execution confirmed</b>',
      fmtLine('Plan:', shortPlanKey(event.planKey)),
      fmtLine('Status:', status),
      fmtLine('Signature:', event.signature ?? 'unknown'),
      fmtLine('Slot:', event.slot != null ? String(event.slot) : 'unknown'),
      fmtLine('Estimated net:', fmtUsd(event.estimatedNetUsd)),
      fmtLine(
        'Chain fee (lamports):',
        event.chainFeeLamports != null ? String(event.chainFeeLamports) : 'unknown',
      ),
    ].join('\n');
  }

  return [
    '❌ <b>LIQSOL execution failed</b>',
    fmtLine('Plan:', shortPlanKey(event.planKey)),
    fmtLine('Status:', status),
    fmtLine('Reason:', event.note ?? status),
    fmtLine('EV:', fmtUsd(event.ev)),
    fmtLine('TTL:', event.ttlStr ?? 'unknown'),
  ].join('\n');
}

export async function maybeNotifyForBotEvent(event: BotEvent): Promise<void> {
  if (!shouldNotify(event)) return;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  const disableNotification = enabled('TELEGRAM_DISABLE_NOTIFICATION', false);

  try {
    const result = await sendTelegramMessage({
      botToken,
      chatId,
      text: buildMessage(event),
      disableNotification,
    });
    if (result.ok) {
      await recordTelegramSendResult({ ok: true });
      return;
    }
    await recordTelegramSendResult({ ok: false, error: result.description });
    logger.warn({ err: result.description ?? 'unknown error' }, '[Notify] Telegram send failed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordTelegramSendResult({ ok: false, error: msg });
    logger.warn({ err: msg }, '[Notify] Telegram send error');
  }
}
