import type { Context } from "grammy";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import type { DbClient } from "../../db/client.js";
import type { Logger } from "../../logger.js";
import * as mappingRepo from "../../db/repository/mapping.repo.js";
import { escapeHtml } from "../../notifications/format.js";
import { isGlobalAdmin } from "../permissions.js";

export interface AdminCommandDeps {
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

/**
 * Guard shared by all admin commands: only global admins, only in a
 * private chat so that emails are never posted into groups.
 */
async function ensureAdminInPrivateChat(
  deps: AdminCommandDeps,
  ctx: Context,
): Promise<boolean> {
  const from = ctx.from;
  if (!ctx.chat || !from) return false;

  if (!isGlobalAdmin(deps.config.adminTelegramIds, from.id)) {
    await replyHtml(ctx, "This command is only available to admins.");
    return false;
  }

  if (ctx.chat.type !== "private") {
    await replyHtml(ctx, "Please use admin commands in a direct message with me.");
    return false;
  }

  return true;
}

async function notifyUser(
  deps: AdminCommandDeps,
  ctx: Context,
  telegramUserId: number,
  text: string,
): Promise<void> {
  try {
    await ctx.api.sendMessage(telegramUserId, text, { parse_mode: "HTML" });
  } catch (error) {
    // Best-effort: the user may have blocked the bot since requesting.
    deps.logger.warn(
      {
        telegramUserId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to notify user about link decision",
    );
  }
}

export async function handleApprove(
  deps: AdminCommandDeps,
  ctx: Context,
): Promise<void> {
  if (!(await ensureAdminInPrivateChat(deps, ctx))) return;

  const parsedEmail = emailSchema.safeParse(commandArgument(ctx));
  if (!parsedEmail.success) {
    await replyHtml(ctx, "Usage: /approve email@example.com");
    return;
  }

  const approved = await mappingRepo.approveByEmail(
    deps.db,
    parsedEmail.data,
    ctx.from!.id,
  );
  if (!approved) {
    await replyHtml(
      ctx,
      `No pending link request found for <code>${escapeHtml(parsedEmail.data)}</code>.`,
    );
    return;
  }

  deps.logger.info(
    { kanEmail: approved.kanEmail, approvedBy: ctx.from!.id },
    "Link request approved",
  );
  await replyHtml(
    ctx,
    `✅ Approved <code>${escapeHtml(approved.kanEmail)}</code>.`,
  );
  await notifyUser(
    deps,
    ctx,
    approved.telegramUserId,
    `✅ Your link to <code>${escapeHtml(approved.kanEmail)}</code> was approved. ` +
      "You will now receive personal notifications.",
  );
}

export async function handleReject(
  deps: AdminCommandDeps,
  ctx: Context,
): Promise<void> {
  if (!(await ensureAdminInPrivateChat(deps, ctx))) return;

  const parsedEmail = emailSchema.safeParse(commandArgument(ctx));
  if (!parsedEmail.success) {
    await replyHtml(ctx, "Usage: /reject email@example.com");
    return;
  }

  const existing = await mappingRepo.getByEmail(deps.db, parsedEmail.data);
  if (!existing) {
    await replyHtml(
      ctx,
      `No link found for <code>${escapeHtml(parsedEmail.data)}</code>.`,
    );
    return;
  }

  await mappingRepo.deleteByEmail(deps.db, existing.kanEmail);
  deps.logger.info(
    { kanEmail: existing.kanEmail, rejectedBy: ctx.from!.id },
    "Link removed by admin",
  );
  await replyHtml(
    ctx,
    `Removed the link for <code>${escapeHtml(existing.kanEmail)}</code>.`,
  );
  await notifyUser(
    deps,
    ctx,
    existing.telegramUserId,
    `Your link to <code>${escapeHtml(existing.kanEmail)}</code> was removed by an admin.`,
  );
}

export async function handleMappings(
  deps: AdminCommandDeps,
  ctx: Context,
): Promise<void> {
  if (!(await ensureAdminInPrivateChat(deps, ctx))) return;

  const mappings = await mappingRepo.listAll(deps.db);
  if (mappings.length === 0) {
    await replyHtml(ctx, "No account links yet.");
    return;
  }

  const lines = mappings.map((mapping) => {
    const icon = mapping.status === "approved" ? "✅" : "⏳";
    const account = mapping.telegramUsername
      ? `@${escapeHtml(mapping.telegramUsername)}`
      : `id ${mapping.telegramUserId}`;
    return `${icon} <code>${escapeHtml(mapping.kanEmail)}</code> → ${account}`;
  });

  await replyHtml(ctx, `<b>Account links</b>\n${lines.join("\n")}`);
}
