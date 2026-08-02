import type { Context } from "grammy";

import type { AppConfig } from "../../config.js";
import type { DbClient } from "../../db/client.js";
import type { Logger } from "../../logger.js";
import * as subscriptionRepo from "../../db/repository/subscription.repo.js";
import { isKanWebhookEvent, KAN_WEBHOOK_EVENTS } from "../../kan/events.js";
import { escapeHtml } from "../../notifications/format.js";
import { canManageSubscription } from "../permissions.js";

export interface SubscriptionCommandDeps {
  db: DbClient;
  config: AppConfig;
  logger: Logger;
}

function commandArguments(ctx: Context): string[] {
  const raw = typeof ctx.match === "string" ? ctx.match : "";
  return raw
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function replyHtml(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text, { parse_mode: "HTML" });
}

function chatTitle(ctx: Context): string | null {
  const chat = ctx.chat;
  if (!chat) return null;
  if (chat.type === "private") {
    return [chat.first_name, chat.last_name].filter(Boolean).join(" ") || null;
  }
  return chat.title ?? null;
}

/**
 * Guard shared by all subscription commands. Replies with the reason and
 * returns false when the command must not run in this chat.
 */
async function ensureCanManage(
  deps: SubscriptionCommandDeps,
  ctx: Context,
): Promise<boolean> {
  const chat = ctx.chat;
  const from = ctx.from;
  if (!chat || !from) return false;

  if (chat.type === "channel") {
    await replyHtml(
      ctx,
      "Channels are not supported. Use a group or a direct message.",
    );
    return false;
  }

  const allowed = await canManageSubscription(
    ctx,
    deps.config.adminTelegramIds,
  );
  if (!allowed) {
    await replyHtml(
      ctx,
      "Only chat administrators can manage this chat's subscription.",
    );
    return false;
  }

  return true;
}

function describeSubscription(subscription: {
  allEvents: boolean;
  events: string[];
  boardPublicIds: string[];
}): string {
  const eventsLine = subscription.allEvents
    ? "Events: all"
    : `Events: ${subscription.events.map(escapeHtml).join(", ")}`;
  const boardsLine =
    subscription.boardPublicIds.length === 0
      ? "Boards: all"
      : `Boards: ${subscription.boardPublicIds.map(escapeHtml).join(", ")}`;
  return `${eventsLine}\n${boardsLine}`;
}

export async function handleSubscribe(
  deps: SubscriptionCommandDeps,
  ctx: Context,
): Promise<void> {
  if (!(await ensureCanManage(deps, ctx))) return;
  const chat = ctx.chat!;
  const from = ctx.from!;

  const requestedEvents = commandArguments(ctx);
  const invalid = requestedEvents.filter((event) => !isKanWebhookEvent(event));
  if (invalid.length > 0) {
    await replyHtml(
      ctx,
      `Unknown event type(s): ${invalid.map(escapeHtml).join(", ")}.\n` +
        "Use /events to see the available event types.",
    );
    return;
  }

  const subscription = await subscriptionRepo.upsert(deps.db, {
    chatId: chat.id,
    chatType: chat.type,
    chatTitle: chatTitle(ctx),
    allEvents: requestedEvents.length === 0,
    events: requestedEvents,
    createdBy: from.id,
  });

  deps.logger.info(
    {
      chatId: chat.id,
      chatType: chat.type,
      allEvents: subscription.allEvents,
      events: subscription.events,
    },
    "Chat subscribed",
  );
  await replyHtml(
    ctx,
    `🔔 This chat will now receive Kan.bn notifications.\n${describeSubscription(subscription)}`,
  );
}

export async function handleUnsubscribe(
  deps: SubscriptionCommandDeps,
  ctx: Context,
): Promise<void> {
  if (!(await ensureCanManage(deps, ctx))) return;
  const chat = ctx.chat!;

  const removed = await subscriptionRepo.deleteByChatId(deps.db, chat.id);
  if (!removed) {
    await replyHtml(ctx, "This chat has no subscription.");
    return;
  }

  deps.logger.info({ chatId: chat.id }, "Chat unsubscribed");
  await replyHtml(ctx, "🔕 This chat will no longer receive notifications.");
}

export async function handleStatus(
  deps: SubscriptionCommandDeps,
  ctx: Context,
): Promise<void> {
  const chat = ctx.chat;
  if (!chat) return;

  const subscription = await subscriptionRepo.getByChatId(deps.db, chat.id);
  if (!subscription) {
    await replyHtml(
      ctx,
      "This chat is not subscribed. Use /subscribe to enable notifications.",
    );
    return;
  }

  await replyHtml(
    ctx,
    `🔔 This chat is subscribed.\n${describeSubscription(subscription)}`,
  );
}

export async function handleEvents(ctx: Context): Promise<void> {
  const lines = KAN_WEBHOOK_EVENTS.map((event) => `• <code>${event}</code>`);
  await replyHtml(
    ctx,
    `<b>Available event types</b>\n${lines.join("\n")}\n\n` +
      "Subscribe to a subset with e.g. /subscribe card.created card.moved",
  );
}

async function showBoardFilter(
  deps: SubscriptionCommandDeps,
  ctx: Context,
): Promise<void> {
  const subscription = await subscriptionRepo.getByChatId(deps.db, ctx.chat!.id);
  if (!subscription) {
    await replyHtml(ctx, "This chat is not subscribed. Use /subscribe first.");
    return;
  }
  await replyHtml(ctx, describeSubscription(subscription));
}

async function clearBoardFilter(
  deps: SubscriptionCommandDeps,
  ctx: Context,
): Promise<void> {
  const updated = await subscriptionRepo.setBoardFilter(deps.db, ctx.chat!.id, []);
  if (!updated) {
    await replyHtml(ctx, "This chat is not subscribed. Use /subscribe first.");
    return;
  }
  await replyHtml(ctx, "Board filter removed — notifying for all boards.");
}

async function setBoardFilter(
  deps: SubscriptionCommandDeps,
  ctx: Context,
  boardPublicIds: string[],
): Promise<void> {
  const updated = await subscriptionRepo.setBoardFilter(
    deps.db,
    ctx.chat!.id,
    boardPublicIds,
  );
  if (!updated) {
    await replyHtml(ctx, "This chat is not subscribed. Use /subscribe first.");
    return;
  }
  await replyHtml(
    ctx,
    `Board filter set.\n${describeSubscription(updated)}\n\n` +
      "Board public IDs are the 12-character part of your Kan board URL.",
  );
}

export async function handleBoards(
  deps: SubscriptionCommandDeps,
  ctx: Context,
): Promise<void> {
  if (!(await ensureCanManage(deps, ctx))) return;

  const args = commandArguments(ctx);
  if (args.length === 0) {
    await showBoardFilter(deps, ctx);
    return;
  }
  if (args.length === 1 && args[0] === "clear") {
    await clearBoardFilter(deps, ctx);
    return;
  }
  await setBoardFilter(deps, ctx, args);
}
