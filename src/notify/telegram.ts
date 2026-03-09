export interface TelegramSendResult {
  ok: boolean;
  description?: string;
  messageId?: number;
}

export function escapeTelegramHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export async function sendTelegramMessage(args: {
  botToken: string;
  chatId: string;
  text: string;
  disableNotification: boolean;
}): Promise<TelegramSendResult> {
  const response = await fetch(`https://api.telegram.org/bot${args.botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: args.chatId,
      text: args.text,
      parse_mode: 'HTML',
      disable_notification: args.disableNotification,
    }),
  });

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.ok !== true) {
    return {
      ok: false,
      description:
        payload?.description ??
        (response.ok ? 'Telegram API returned non-ok response' : `HTTP ${response.status}`),
    };
  }

  return {
    ok: true,
    messageId: payload?.result?.message_id,
  };
}
