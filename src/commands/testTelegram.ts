import { config as dotenvConfig } from 'dotenv';
import { sendTelegramMessage } from '../notify/telegram.js';

async function main() {
  dotenvConfig();

  if ((process.env.TELEGRAM_ENABLED ?? 'false') !== 'true') {
    throw new Error('TELEGRAM_ENABLED must be true');
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
  }

  const mode = (process.env.LIQSOL_BROADCAST ?? 'false') === 'true' ? 'broadcast' : 'dry';
  const text = `🧪 LIQSOL Telegram test\nMode: ${mode}\nTime: ${new Date().toISOString()}`;
  const disableNotification = (process.env.TELEGRAM_DISABLE_NOTIFICATION ?? 'false') === 'true';
  const result = await sendTelegramMessage({
    botToken,
    chatId,
    text,
    disableNotification,
  });
  if (!result.ok) {
    throw new Error(result.description ?? 'Telegram send failed');
  }
  console.log(`Telegram test sent (messageId=${result.messageId ?? 'n/a'})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
