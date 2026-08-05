import { Bot } from "grammy";

import { loadConfig, TELEGRAM_WEBHOOK_PATH } from "../config.js";
import { publishBotCommands } from "../telegram/bot.js";

/**
 * Point Telegram at this service's update route, or hand the bot back to
 * long polling with --delete.
 *
 * This is a deploy-time step on purpose: calling setWebhook on every start
 * would add Telegram round-trips to each cold start, which is exactly what
 * serverless mode is trying to avoid.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const bot = new Bot(config.telegramBotToken);

  if (process.argv.includes("--delete")) {
    await bot.api.deleteWebhook();
    console.log("Webhook deleted; the bot can be run with long polling again.");
    return;
  }

  if (config.publicUrl === undefined) {
    throw new Error(
      "PUBLIC_URL is required to register a webhook (e.g. PUBLIC_URL=https://service.example.com)",
    );
  }

  const url = `${config.publicUrl}${TELEGRAM_WEBHOOK_PATH}`;
  await bot.api.setWebhook(url, {
    secret_token: config.telegramWebhookSecret,
    // The bot only reacts to commands and chat migrations, both of which
    // are message updates. Anything else would just be dropped.
    allowed_updates: ["message"],
  });
  await publishBotCommands(bot);

  const info = await bot.api.getWebhookInfo();
  console.log("Webhook registered and bot commands published.");
  console.log(
    JSON.stringify(
      {
        url: info.url,
        pendingUpdateCount: info.pending_update_count,
        allowedUpdates: info.allowed_updates,
        lastErrorMessage: info.last_error_message,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(
    "Failed to configure the Telegram webhook:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
