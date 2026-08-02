import { Bot } from "grammy";

import type { AppConfig } from "../config.js";
import type { DbClient } from "../db/client.js";
import type { Logger } from "../logger.js";
import {
  handleApprove,
  handleMappings,
  handleReject,
} from "./commands/admin.js";
import { handleHelp } from "./commands/help.js";
import { handleLink, handleUnlink, handleWhoami } from "./commands/link.js";
import {
  handleBoards,
  handleEvents,
  handleStatus,
  handleSubscribe,
  handleUnsubscribe,
} from "./commands/subscription.js";

export interface BotDeps {
  db: DbClient;
  config: AppConfig;
  logger: Logger;
}

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.config.telegramBotToken);

  bot.catch((error) => {
    deps.logger.error(
      {
        updateId: error.ctx.update.update_id,
        error: error.error instanceof Error ? error.error.message : String(error.error),
      },
      "Unhandled error in bot update handler",
    );
  });

  bot.command(["start", "help"], (ctx) => handleHelp(ctx));

  bot.command("link", (ctx) => handleLink(deps, ctx));
  bot.command("unlink", (ctx) => handleUnlink(deps, ctx));
  bot.command("whoami", (ctx) => handleWhoami(deps, ctx));

  bot.command("subscribe", (ctx) => handleSubscribe(deps, ctx));
  bot.command("unsubscribe", (ctx) => handleUnsubscribe(deps, ctx));
  bot.command("status", (ctx) => handleStatus(deps, ctx));
  bot.command("events", (ctx) => handleEvents(ctx));
  bot.command("boards", (ctx) => handleBoards(deps, ctx));

  bot.command("approve", (ctx) => handleApprove(deps, ctx));
  bot.command("reject", (ctx) => handleReject(deps, ctx));
  bot.command("mappings", (ctx) => handleMappings(deps, ctx));

  return bot;
}

/**
 * Publish the command list shown in the Telegram UI. Admin commands are
 * intentionally omitted so they are not advertised to every user.
 */
export async function publishBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: "help", description: "Show help" },
    { command: "link", description: "Link your Kan account (DM only)" },
    { command: "unlink", description: "Remove your Kan account link" },
    { command: "whoami", description: "Show your link status" },
    { command: "subscribe", description: "Notify this chat about Kan events" },
    { command: "unsubscribe", description: "Stop notifying this chat" },
    { command: "status", description: "Show this chat's subscription" },
    { command: "events", description: "List available event types" },
    { command: "boards", description: "Filter notifications by board" },
  ]);
}
