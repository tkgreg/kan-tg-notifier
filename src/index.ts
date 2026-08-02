import { loadConfig } from "./config.js";
import { createDbConnection } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import * as eventRepo from "./db/repository/event.repo.js";
import { createLogger } from "./logger.js";
import { processEvent } from "./notifications/processor.js";
import { createSerialQueue } from "./notifications/queue.js";
import { createWebhookServer } from "./server.js";
import { createBot, publishBotCommands } from "./telegram/bot.js";
import { TelegramNotifier } from "./telegram/notifier.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);

  logger.info("Applying database migrations");
  await runMigrations(config.databaseUrl);

  const { db, close: closeDb } = createDbConnection(config.databaseUrl);

  const bot = createBot({ db, config, logger: logger.child({ component: "bot" }) });
  const notifier = new TelegramNotifier(
    bot.api,
    logger.child({ component: "notifier" }),
  );

  const processorDeps = {
    db,
    notifier,
    logger: logger.child({ component: "processor" }),
    kanBaseUrl: config.kanBaseUrl,
  };
  const queue = createSerialQueue((error) => {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Event processing task failed",
    );
  });

  const server = createWebhookServer({
    webhookSecret: config.webhookSecret,
    timestampToleranceSeconds: config.webhookTimestampToleranceSeconds,
    logger: logger.child({ component: "server" }),
    onEvent: async (payload) => {
      const eventLogId = await eventRepo.insertReceived(db, payload);
      queue.push(() => processEvent(processorDeps, eventLogId, payload));
    },
  });

  await server.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port }, "Webhook server listening");

  await publishBotCommands(bot);
  bot.start({
    onStart: (me) => logger.info({ username: me.username }, "Bot started"),
  }).catch((error: unknown) => {
    logger.fatal(
      { error: error instanceof Error ? error.message : String(error) },
      "Bot polling crashed",
    );
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    await bot.stop();
    await server.close();
    await queue.onIdle();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  // Startup failed before the logger may exist; stderr is the only safe sink.
  console.error("Fatal startup error:", error);
  process.exit(1);
});
