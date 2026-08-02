import type { Context } from "grammy";
import { Bot } from "grammy";

import type { AppConfig } from "../config.js";
import type { DbClient } from "../db/client.js";
import type { Logger } from "../logger.js";
import * as subscriptionRepo from "../db/repository/subscription.repo.js";
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
        error:
          error.error instanceof Error
            ? error.error.message
            : String(error.error),
      },
      "Unhandled error in bot update handler",
    );
  });

  // Command handlers must never fail silently: log and tell the user.
  const safely =
    (handler: (ctx: Context) => Promise<void>) =>
    async (ctx: Context): Promise<void> => {
      try {
        await handler(ctx);
      } catch (error) {
        deps.logger.error(
          {
            updateId: ctx.update.update_id,
            chatId: ctx.chat?.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "Command handler failed",
        );
        try {
          await ctx.reply("Something went wrong — please try again.");
        } catch {
          // The chat may be unreachable; the error is already logged.
        }
      }
    };

  bot.command(["start", "help"], safely((ctx) => handleHelp(ctx)));

  bot.command("link", safely((ctx) => handleLink(deps, ctx)));
  bot.command("unlink", safely((ctx) => handleUnlink(deps, ctx)));
  bot.command("whoami", safely((ctx) => handleWhoami(deps, ctx)));

  bot.command("subscribe", safely((ctx) => handleSubscribe(deps, ctx)));
  bot.command("unsubscribe", safely((ctx) => handleUnsubscribe(deps, ctx)));
  bot.command("status", safely((ctx) => handleStatus(deps, ctx)));
  bot.command("events", safely((ctx) => handleEvents(ctx)));
  bot.command("boards", safely((ctx) => handleBoards(deps, ctx)));

  bot.command("approve", safely((ctx) => handleApprove(deps, ctx)));
  bot.command("reject", safely((ctx) => handleReject(deps, ctx)));
  bot.command("mappings", safely((ctx) => handleMappings(deps, ctx)));

  // Keep the subscription alive when Telegram upgrades a basic group to
  // a supergroup: the chat id changes and the old one stops working.
  bot.on("message:migrate_to_chat_id", async (ctx) => {
    const newChatId = ctx.msg.migrate_to_chat_id;
    try {
      await subscriptionRepo.migrateChatId(deps.db, ctx.chat.id, newChatId);
      deps.logger.info(
        { oldChatId: ctx.chat.id, newChatId },
        "Chat migrated to supergroup; subscription moved",
      );
    } catch (error) {
      deps.logger.error(
        {
          oldChatId: ctx.chat.id,
          newChatId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to move subscription after chat migration",
      );
    }
  });

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
