import type { Context } from "grammy";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import type { DbClient } from "../../db/client.js";
import type { Logger } from "../../logger.js";
import * as mappingRepo from "../../db/repository/mapping.repo.js";
import { escapeHtml } from "../../notifications/format.js";
import { isGlobalAdmin } from "../permissions.js";

export interface LinkCommandDeps {
  db: DbClient;
  config: AppConfig;
  logger: Logger;
}

const emailSchema = z.string().email();

function commandArgument(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match.trim() : "";
}

async function replyHtml(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text, { parse_mode: "HTML" });
}

async function notifyAdminsAboutRequest(
  deps: LinkCommandDeps,
  ctx: Context,
  email: string,
): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  const requester = from.username ? `@${from.username}` : `id ${from.id}`;
  const text =
    `🔗 New link request: <b>${escapeHtml(requester)}</b> wants to link ` +
    `<code>${escapeHtml(email)}</code>.\n` +
    `Use /approve ${escapeHtml(email)} or /reject ${escapeHtml(email)}.`;

  for (const adminId of deps.config.adminTelegramIds) {
    if (adminId === from.id) continue;
    try {
      await ctx.api.sendMessage(adminId, text, { parse_mode: "HTML" });
    } catch (error) {
      // Best-effort: an admin who never started the bot cannot receive DMs.
      deps.logger.warn(
        {
          adminId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to notify admin about link request",
      );
    }
  }
}

export async function handleLink(
  deps: LinkCommandDeps,
  ctx: Context,
): Promise<void> {
  const from = ctx.from;
  if (!ctx.chat || !from) return;

  if (ctx.chat.type !== "private") {
    await replyHtml(ctx, "Please use /link in a direct message with me.");
    return;
  }

  const argument = commandArgument(ctx);
  const parsedEmail = emailSchema.safeParse(argument);
  if (!parsedEmail.success) {
    await replyHtml(
      ctx,
      "Usage: /link email@example.com — the email of your Kan (OIDC) account.",
    );
    return;
  }
  const email = mappingRepo.normalizeEmail(parsedEmail.data);

  const existingOwn = await mappingRepo.getByTelegramUserId(deps.db, from.id);
  if (existingOwn) {
    const state =
      existingOwn.status === "approved" ? "linked" : "pending approval";
    await replyHtml(
      ctx,
      `You are already ${state} for <code>${escapeHtml(existingOwn.kanEmail)}</code>. ` +
        "Use /unlink first to link a different email.",
    );
    return;
  }

  const existingEmail = await mappingRepo.getByEmail(deps.db, email);
  if (existingEmail) {
    await replyHtml(
      ctx,
      "That email is already linked to another Telegram account. " +
        "Ask an admin to /reject the existing link if this is a mistake.",
    );
    return;
  }

  const autoApproved =
    deps.config.autoApproveLinks ||
    isGlobalAdmin(deps.config.adminTelegramIds, from.id);

  const mapping = await mappingRepo.create(deps.db, {
    telegramUserId: from.id,
    telegramUsername: from.username ?? null,
    kanEmail: email,
    status: autoApproved ? "approved" : "pending",
    ...(autoApproved ? { approvedBy: from.id } : {}),
  });

  deps.logger.info(
    {
      telegramUserId: from.id,
      kanEmail: mapping.kanEmail,
      status: mapping.status,
    },
    "Link request created",
  );

  if (mapping.status === "approved") {
    await replyHtml(
      ctx,
      `✅ Linked <code>${escapeHtml(mapping.kanEmail)}</code>. ` +
        "You will now receive personal notifications, e.g. when you are assigned to a card.",
    );
    return;
  }

  await replyHtml(
    ctx,
    `⏳ Link request for <code>${escapeHtml(mapping.kanEmail)}</code> recorded. ` +
      "An admin has to approve it — you will be notified here.",
  );
  await notifyAdminsAboutRequest(deps, ctx, mapping.kanEmail);
}

export async function handleUnlink(
  deps: LinkCommandDeps,
  ctx: Context,
): Promise<void> {
  const from = ctx.from;
  if (!ctx.chat || !from) return;

  if (ctx.chat.type !== "private") {
    await replyHtml(ctx, "Please use /unlink in a direct message with me.");
    return;
  }

  const removed = await mappingRepo.deleteByTelegramUserId(deps.db, from.id);
  if (!removed) {
    await replyHtml(ctx, "You have no linked Kan account.");
    return;
  }

  deps.logger.info(
    { telegramUserId: from.id, kanEmail: removed.kanEmail },
    "Link removed by user",
  );
  await replyHtml(
    ctx,
    `Removed the link to <code>${escapeHtml(removed.kanEmail)}</code>.`,
  );
}

export async function handleWhoami(
  deps: LinkCommandDeps,
  ctx: Context,
): Promise<void> {
  const from = ctx.from;
  if (!ctx.chat || !from) return;

  if (ctx.chat.type !== "private") {
    await replyHtml(ctx, "Please use /whoami in a direct message with me.");
    return;
  }

  const mapping = await mappingRepo.getByTelegramUserId(deps.db, from.id);
  if (!mapping) {
    await replyHtml(
      ctx,
      "You have no linked Kan account. Use /link email@example.com to create one.",
    );
    return;
  }

  const statusLine =
    mapping.status === "approved"
      ? "✅ approved"
      : "⏳ pending admin approval";
  await replyHtml(
    ctx,
    `Kan account: <code>${escapeHtml(mapping.kanEmail)}</code>\nStatus: ${statusLine}`,
  );
}
