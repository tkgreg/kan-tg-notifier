import { sql } from "drizzle-orm";
import { z } from "zod";

import type { DbClient } from "../db/client.js";
import type { NewPulseTelegramMessage } from "../db/schema.js";
import { pulseTelegramInbox } from "../db/schema.js";

const positiveId = z.number().int().safe().positive();
const messageSchema = z.object({
  message_id: positiveId,
  date: z.number().int().min(0).max(253402300799),
  edit_date: z.number().int().min(0).max(253402300799).optional(),
  message_thread_id: positiveId.optional(),
  chat: z.object({
    id: z.number().int().safe().negative(),
    type: z.enum(["group", "supergroup"]),
    title: z.string().max(500).optional(),
    username: z.string().max(255).optional(),
  }),
  from: z
    .object({ id: positiveId, username: z.string().max(255).optional() })
    .optional(),
  text: z.string().max(40000).optional(),
  caption: z.string().max(40000).optional(),
});
const updateSchema = z.object({
  update_id: z.number().int().safe().nonnegative(),
  message: messageSchema.optional(),
  edited_message: messageSchema.optional(),
});

/** Discard private chats, other groups, non-text content, and unexpected fields. */
export function parsePulseMessage(
  update: unknown,
  botId: number,
  allowedChatIds: readonly number[],
): NewPulseTelegramMessage | undefined {
  if (allowedChatIds.length === 0) return undefined;
  const parsed = updateSchema.safeParse(update);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  const message = value.edited_message ?? value.message;
  if (!message || !allowedChatIds.includes(message.chat.id)) return undefined;
  const body = message.text ?? message.caption;
  if (body === undefined) return undefined;
  return {
    botId,
    updateId: value.update_id,
    chatId: message.chat.id,
    messageId: message.message_id,
    updateType: value.edited_message ? "edited_message" : "message",
    chatTitle: message.chat.title ?? "Telegram group",
    chatUsername: message.chat.username ?? null,
    authorId: message.from?.id ?? null,
    authorUsername: message.from?.username ?? null,
    messageThreadId: message.message_thread_id ?? null,
    body,
    occurredAt: new Date((message.edit_date ?? message.date) * 1000),
  };
}

/** Resolve only after commit; ordered IDs remain safe for a per-bot read cursor. */
export async function capturePulseUpdate(
  db: DbClient,
  update: unknown,
  botId: number,
  allowedChatIds: readonly number[],
): Promise<void> {
  const message = parsePulseMessage(update, botId, allowedChatIds);
  if (!message) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    await tx.execute(sql`SET LOCAL lock_timeout = '3000ms'`);
    // Acquire before INSERT assigns its sequence ID. A later per-bot row cannot
    // commit first and cause an hourly collector to skip an in-flight row.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pulse-telegram-inbox:${botId}`}, 0))`,
    );
    await tx
      .insert(pulseTelegramInbox)
      .values(message)
      .onConflictDoNothing({
        target: [pulseTelegramInbox.botId, pulseTelegramInbox.updateId],
      });
  });
}
