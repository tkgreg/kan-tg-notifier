import type { Bot } from "grammy";
import type { Update } from "grammy/types";

import type { AppConfig } from "./config.js";
import type { DbClient } from "./db/client.js";
import type { KanWebhookPayload } from "./kan/events.js";
import type { Logger } from "./logger.js";
import type { ProcessorDeps } from "./notifications/processor.js";
import type { SerialQueue } from "./notifications/queue.js";
import { loadConfig, TELEGRAM_WEBHOOK_PATH } from "./config.js";
import { createDbConnection } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import * as eventRepo from "./db/repository/event.repo.js";
import { kanWebhookPayloadSchema } from "./kan/events.js";
import { createLogger } from "./logger.js";
import { createCardAggregator } from "./notifications/aggregator.js";
import { processEvent, processEventBatch } from "./notifications/processor.js";
import { createSerialQueue } from "./notifications/queue.js";
import { createWebhookServer } from "./server.js";
import { createBot, publishBotCommands } from "./telegram/bot.js";
import { TelegramNotifier } from "./telegram/notifier.js";

const RECOVERY_BATCH_SIZE = 500;
/**
 * Serverless recovery runs inside a request that Kan only waits 10s for,
 * so it takes a small bite per cold start instead of the whole backlog.
 */
const SERVERLESS_RECOVERY_BATCH_SIZE = 10;
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface RecoverableEvent {
  id: number;
  payload: KanWebhookPayload;
}

/**
 * Events that were acknowledged with 202 but never processed, e.g. because
 * the process was killed before the queue drained. Kan sends each delivery
 * exactly once, so these would otherwise be lost. Entries whose stored
 * payload no longer parses are marked failed and skipped.
 */
async function loadRecoverableEvents(
  db: DbClient,
  logger: Logger,
  limit: number,
  excludeId?: number,
): Promise<RecoverableEvent[]> {
  const pending = await eventRepo.listUnprocessed(db, limit);
  const recoverable: RecoverableEvent[] = [];

  for (const entry of pending) {
    if (entry.id === excludeId) continue;

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
    recoverable.push({ id: entry.id, payload: parsed.data });
  }

  if (recoverable.length > 0) {
    logger.info(
      { count: recoverable.length },
      "Recovered unprocessed events from a previous run",
    );
  }
  return recoverable;
}

async function sweepEventLog(
  db: DbClient,
  retentionDays: number,
  logger: Logger,
): Promise<void> {
  if (retentionDays === 0) return;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await eventRepo.deleteReceivedBefore(db, cutoff);
  if (deleted > 0) {
    logger.info({ deleted, retentionDays }, "Pruned old event log entries");
  }
}

function startRetentionSweep(
  db: DbClient,
  retentionDays: number,
  logger: Logger,
): void {
  if (retentionDays === 0) return;

  const sweep = (): Promise<void> => sweepEventLog(db, retentionDays, logger);
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

interface Runtime {
  config: AppConfig;
  logger: Logger;
  db: DbClient;
  closeDb: () => Promise<void>;
  bot: Bot;
  processorDeps: ProcessorDeps;
}

/**
 * Long-lived process: the bot polls getUpdates, webhook deliveries are
 * acknowledged with 202 and processed afterwards on a serial queue, and a
 * timer prunes the event log.
 */
async function runPersistent(runtime: Runtime): Promise<void> {
  const { config, logger, db, closeDb, bot, processorDeps } = runtime;

  const queue: SerialQueue = createSerialQueue((error) => {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Event processing task failed",
    );
  });

  // Kan sends one webhook per elementary action, so creating a card with
  // an assignee arrives as several deliveries within moments. Collect
  // events per card for a short window and deliver one combined message.
  const aggregator = createCardAggregator(
    config.eventAggregationSeconds * 1000,
    (events) => {
      queue.push(() => processEventBatch(processorDeps, events));
    },
  );

  const pending = await loadRecoverableEvents(db, logger, RECOVERY_BATCH_SIZE);
  for (const event of pending) {
    aggregator.push(event);
  }
  startRetentionSweep(db, config.eventLogRetentionDays, logger);

  const server = createWebhookServer({
    webhookSecret: config.webhookSecret,
    timestampToleranceSeconds: config.webhookTimestampToleranceSeconds,
    logger: logger.child({ component: "server" }),
    onEvent: async (payload, payloadHash) => {
      const eventLogId = await eventRepo.insertReceived(
        db,
        payload,
        payloadHash,
      );
      if (eventLogId === undefined) return "duplicate";
      aggregator.push({ id: eventLogId, payload });
      return "accepted";
    },
  });

  await server.listen({ host: config.host, port: config.port });
  logger.info(
    { host: config.host, port: config.port },
    "Webhook server listening",
  );

  await publishBotCommands(bot);
  bot
    .start({
      onStart: (me) => logger.info({ username: me.username }, "Bot started"),
    })
    .catch((error: unknown) => {
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
    aggregator.flushAll();
    await queue.onIdle();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/**
 * Scale-to-zero process: no work may outlive a request, because the
 * platform is free to freeze the CPU or stop the instance as soon as the
 * response is flushed. Telegram updates therefore arrive over HTTP,
 * notifications are delivered before the Kan webhook is acknowledged, and
 * the maintenance that timers used to do runs once per instance inside a
 * request.
 */
async function runServerless(runtime: Runtime): Promise<void> {
  const { config, logger, db, closeDb, bot, processorDeps } = runtime;

  // Long polling does this implicitly; a webhook-driven bot has to
  // initialize itself before it can dispatch an update.
  await bot.init();

  let maintenanceDone = false;
  /**
   * One retention sweep plus a bounded recovery pass per instance. The
   * event being handled right now is excluded: it is already stored, and
   * reprocessing it here could resend notifications that just went out.
   */
  const runMaintenanceOnce = async (excludeId?: number): Promise<void> => {
    if (maintenanceDone) return;
    maintenanceDone = true;
    try {
      await sweepEventLog(db, config.eventLogRetentionDays, logger);
      const pending = await loadRecoverableEvents(
        db,
        logger,
        SERVERLESS_RECOVERY_BATCH_SIZE,
        excludeId,
      );
      for (const event of pending) {
        await processEvent(processorDeps, event.id, event.payload);
      }
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Instance maintenance pass failed",
      );
    }
  };

  const server = createWebhookServer({
    webhookSecret: config.webhookSecret,
    timestampToleranceSeconds: config.webhookTimestampToleranceSeconds,
    logger: logger.child({ component: "server" }),
    onEvent: async (payload, payloadHash) => {
      const eventLogId = await eventRepo.insertReceived(
        db,
        payload,
        payloadHash,
      );
      if (eventLogId === undefined) return "duplicate";

      try {
        await processEvent(processorDeps, eventLogId, payload);
      } catch (error) {
        // The row stays "received", so a later request recovers it.
        // Acknowledging anyway is still right: Kan never retries, so a 500
        // would lose the delivery on its side without helping ours.
        logger.error(
          {
            eventLogId,
            event: payload.event,
            error: error instanceof Error ? error.message : String(error),
          },
          "Event processing failed; left for recovery",
        );
      }
      await runMaintenanceOnce(eventLogId);
      return "accepted";
    },
    telegramUpdates: {
      path: TELEGRAM_WEBHOOK_PATH,
      secretToken: config.telegramWebhookSecret,
      handleUpdate: async (update) => {
        await bot.handleUpdate(update as Update);
        await runMaintenanceOnce();
      },
    },
  });

  await server.listen({ host: config.host, port: config.port });
  logger.info(
    {
      host: config.host,
      port: config.port,
      telegramWebhookPath: TELEGRAM_WEBHOOK_PATH,
    },
    "Webhook server listening (serverless mode)",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    await server.close();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
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

  if (config.runMigrations) {
    logger.info("Applying database migrations");
    await runMigrations(config.databaseUrl);
  }

  const { db, close: closeDb } = createDbConnection(
    config.databaseUrl,
    (error) =>
      logger.warn({ error: error.message }, "Idle database client error"),
  );

  const bot = createBot({
    db,
    config,
    logger: logger.child({ component: "bot" }),
  });
  const notifier = new TelegramNotifier(
    bot.api,
    logger.child({ component: "notifier" }),
  );

  const runtime: Runtime = {
    config,
    logger,
    db,
    closeDb,
    bot,
    processorDeps: {
      db,
      notifier,
      logger: logger.child({ component: "processor" }),
      kanBaseUrl: config.kanBaseUrl,
      groupMemberMentions: config.groupMemberMentions,
    },
  };

  if (config.runtimeMode === "serverless") {
    await runServerless(runtime);
    return;
  }
  await runPersistent(runtime);
}

main().catch((error: unknown) => {
  // Startup failed before the logger may exist; stderr is the only safe sink.
  console.error("Fatal startup error:", error);
  process.exit(1);
});
