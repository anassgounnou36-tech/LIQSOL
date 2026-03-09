import { afterEach, describe, expect, it, vi } from 'vitest';
import { escapeTelegramHtml, sendTelegramMessage } from '../notify/telegram.js';
import { maybeNotifyForBotEvent } from '../notify/notificationRouter.js';

describe('telegram sender and router', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.TELEGRAM_ENABLED = 'false';
    process.env.METRICS_ENABLED = 'false';
    vi.restoreAllMocks();
  });

  it('Telegram sender hits correct endpoint path shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 123 } }),
    });
    globalThis.fetch = fetchMock as any;

    const result = await sendTelegramMessage({
      botToken: 'abc-token',
      chatId: '12345',
      text: 'hello',
      disableNotification: false,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.telegram.org/botabc-token/sendMessage');
  });

  it('HTML escaping works', () => {
    expect(escapeTelegramHtml('<x & y> "z"')).toBe('&lt;x &amp; y&gt; &quot;z&quot;');
  });

  it('non-ok Telegram response becomes failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, description: 'chat not found' }),
    }) as any;

    const result = await sendTelegramMessage({
      botToken: 'abc-token',
      chatId: '12345',
      text: 'hello',
      disableNotification: false,
    });
    expect(result).toEqual({ ok: false, description: 'chat not found' });
  });

  it('notification router suppresses events when disabled', async () => {
    process.env.TELEGRAM_ENABLED = 'false';
    process.env.METRICS_ENABLED = 'false';
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;

    await maybeNotifyForBotEvent({
      ts: new Date().toISOString(),
      kind: 'execution-attempt-result',
      status: 'confirmed',
      broadcast: true,
      planKey: 'plan-1',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('notification router suppresses low-EV queue additions', async () => {
    process.env.TELEGRAM_ENABLED = 'true';
    process.env.TELEGRAM_NOTIFY_QUEUE_ADDED = 'true';
    process.env.TELEGRAM_NOTIFY_MIN_EV = '100';
    process.env.TELEGRAM_BOT_TOKEN = 'abc-token';
    process.env.TELEGRAM_CHAT_ID = '12345';
    process.env.METRICS_ENABLED = 'false';
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;

    await maybeNotifyForBotEvent({
      ts: new Date().toISOString(),
      kind: 'queue-opportunity-added',
      planKey: 'plan-1',
      ev: 5,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
