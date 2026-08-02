import type { Context } from "grammy";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import type { DbClient } from "../../db/client.js";
import type { Logger } from "../../logger.js";
import { isUniqueViolation } from "../../db/errors.js";
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

async function notifyAdmins(
  deps: LinkCommandDeps,
  ctx: Context,
  text: string,
): Promise<void> {
  const from = ctx.from;
  if (!from) return;

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

function requesterLabel(ctx: Context): string {
  const from = ctx.from;
  if (!from) return "unknown";
  return from.username ? `@${from.username} (id ${from.id})` : `id ${from.id}`;
}

/**
 * The reply for a recorded (or silently conflicting) link request. It is
 * deliberately identical in both cases so /link cannot be used to probe
 * which emails are registered.
 */
async function replyRequestRecorded(ctx: Context, email: string): Promise<void> {
  await ctx.reply(
    `⏳ Link request for <code>${escapeHtml(email)}</code> recorded. ` +
      "An admin has to approve it — you will be notified here.",
    { parse_mode: "HTML" },
  );
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

  const autoApproved =
    deps.config.autoApproveLinks ||
    isGlobalAdmin(deps.config.adminTelegramIds, from.id);

  const existingEmail = await mappingRepo.getByEmail(deps.db, email);
  if (existingEmail) {
    if (autoApproved) {
      // Trusted requester (admin, or auto-approve environment): an
      // honest answer is more useful than enumeration resistance.
      await replyHtml(
        ctx,
        "That email is already linked to another Telegram account. " +
          "Ask an admin to /reject the existing link if this is a mistake.",
      );
      return;
    }
    // Same reply as a successful request, so /link cannot be used to
    // probe which emails are registered. Only admins see the conflict.
    await replyRequestRecorded(ctx, email);
    await notifyAdmins(
      deps,
      ctx,
      `⚠️ ${escapeHtml(requesterLabel(ctx))} requested a link to ` +
        `<code>${escapeHtml(email)}</code>, which is already linked to another ` +
        "account. No new request was stored. If this is a legitimate takeover, " +
        `/reject ${escapeHtml(email)} first and let them retry.`,
    );
    return;
  }

  let mapping: Awaited<ReturnType<typeof mappingRepo.create>>;
  try {
    mapping = await mappingRepo.create(deps.db, {
      telegramUserId: from.id,
      telegramUsername: from.username ?? null,
      kanEmail: email,
      status: autoApproved ? "approved" : "pending",
      ...(autoApproved ? { approvedBy: from.id } : {}),
    });
  } catch (error) {
    // Concurrent request took the email or this Telegram account
    // between the pre-checks and the insert.
    if (isUniqueViolation(error)) {
      if (autoApproved) {
        await replyHtml(
          ctx,
          "That email or your account was linked concurrently. Use /whoami to check.",
        );
        return;
      }
      await replyRequestRecorded(ctx, email);
      return;
    }
    throw error;
  }

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

  await replyRequestRecorded(ctx, mapping.kanEmail);
  await notifyAdmins(
    deps,
    ctx,
    `🔗 New link request: <b>${escapeHtml(requesterLabel(ctx))}</b> wants to link ` +
      `<code>${escapeHtml(mapping.kanEmail)}</code>.\n` +
      "Verify they really own this email before approving.\n" +
      `Use /approve ${escapeHtml(mapping.kanEmail)} or /reject ${escapeHtml(mapping.kanEmail)}.`,
  );
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
