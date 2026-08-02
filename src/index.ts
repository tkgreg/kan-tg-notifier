import type { DbClient } from "./db/client.js";
import type { Logger } from "./logger.js";
import type { ProcessorDeps } from "./notifications/processor.js";
import type { SerialQueue } from "./notifications/queue.js";
import { loadConfig } from "./config.js";
import { createDbConnection } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import * as eventRepo from "./db/repository/event.repo.js";
import { kanWebhookPayloadSchema } from "./kan/events.js";
import { createLogger } from "./logger.js";
import { processEvent } from "./notifications/processor.js";
import { createSerialQueue } from "./notifications/queue.js";
import { createWebhookServer } from "./server.js";
import { createBot, publishBotCommands } from "./telegram/bot.js";
import { TelegramNotifier } from "./telegram/notifier.js";

const RECOVERY_BATCH_SIZE = 500;
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Re-enqueue events that were acknowledged with 202 but never processed,
 * e.g. because the process was killed before the queue drained. Kan
 * sends each delivery exactly once, so these would otherwise be lost.
 */
async function recoverUnprocessedEvents(
  db: DbClient,
  queue: SerialQueue,
  processorDeps: ProcessorDeps,
  logger: Logger,
): Promise<void> {
  const pending = await eventRepo.listUnprocessed(db, RECOVERY_BATCH_SIZE);
  if (pending.length === 0) return;

  for (const entry of pending) {
    const parsed = kanWebhookPayloadSchema.safeParse(entry.payload);
    if (!parsed.success) {
      await eventRepo.markFailed(
        db,
        entry.id,
        `Stored payload no longer parses: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        0,
      );
      continue;
    }
    queue.push(() => processEvent(processorDeps, entry.id, parsed.data));
  }
  logger.info(
    { count: pending.length },
    "Recovered unprocessed events from a previous run",
  );
}

function startRetentionSweep(
  db: DbClient,
  retentionDays: number,
  logger: Logger,
): void {
  if (retentionDays === 0) return;

  const sweep = async (): Promise<void> => {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const deleted = await eventRepo.deleteReceivedBefore(db, cutoff);
    if (deleted > 0) {
      logger.info({ deleted, retentionDays }, "Pruned old event log entries");
    }
  };
  const logSweepError = (error: unknown): void => {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Event log retention sweep failed",
    );
  };

  sweep().catch(logSweepError);
  setInterval(() => {
    sweep().catch(logSweepError);
  }, RETENTION_SWEEP_INTERVAL_MS).unref();
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);

  if (!config.autoApproveLinks && config.adminTelegramIds.length === 0) {
    logger.warn(
      "ADMIN_TELEGRAM_IDS is empty and AUTO_APPROVE_LINKS is false: " +
        "/link requests can never be approved and nobody can subscribe chats",
    );
  }

  logger.info("Applying database migrations");
  await runMigrations(config.databaseUrl);

  const { db, close: closeDb } = createDbConnection(
    config.databaseUrl,
    (error) => logger.warn({ error: error.message }, "Idle database client error"),
  );

  const bot = createBot({ db, config, logger: logger.child({ component: "bot" }) });
  const notifier = new TelegramNotifier(
    bot.api,
    logger.child({ component: "notifier" }),
  );

  const processorDeps: ProcessorDeps = {
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

  await recoverUnprocessedEvents(db, queue, processorDeps, logger);
  startRetentionSweep(db, config.eventLogRetentionDays, logger);

  const server = createWebhookServer({
    webhookSecret: config.webhookSecret,
    timestampToleranceSeconds: config.webhookTimestampToleranceSeconds,
    logger: logger.child({ component: "server" }),
    onEvent: async (payload, payloadHash) => {
      const eventLogId = await eventRepo.insertReceived(db, payload, payloadHash);
      if (eventLogId === undefined) return "duplicate";
      queue.push(() => processEvent(processorDeps, eventLogId, payload));
      return "accepted";
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
