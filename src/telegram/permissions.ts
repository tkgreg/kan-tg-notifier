import type { Context } from "grammy";

import type { DbClient } from "../db/client.js";
import * as mappingRepo from "../db/repository/mapping.repo.js";

export function isGlobalAdmin(
  adminIds: readonly number[],
  userId: number,
): boolean {
  return adminIds.includes(userId);
}

/**
 * True when the message was posted by an anonymous group admin: Telegram
 * then sets from to the GroupAnonymousBot sentinel and sender_chat to the
 * group itself. Only administrators can post as the group.
 */
export function isAnonymousGroupAdmin(ctx: Context): boolean {
  const senderChatId = ctx.msg?.sender_chat?.id;
  return senderChatId !== undefined && senderChatId === ctx.chat?.id;
}

/**
 * Decide whether the sender has chat-level rights to manage the current
 * chat's subscription: anyone in their own private chat; chat admins
 * (including anonymous ones), and global admins in groups.
 */
export async function canManageSubscription(
  ctx: Context,
  adminIds: readonly number[],
): Promise<boolean> {
  const chat = ctx.chat;
  const from = ctx.from;
  if (!chat || !from) return false;

  if (chat.type === "private") return true;

  if (chat.type === "group" || chat.type === "supergroup") {
    if (isAnonymousGroupAdmin(ctx)) return true;
    if (isGlobalAdmin(adminIds, from.id)) return true;
    try {
      const member = await ctx.getChatMember(from.id);
      return member.status === "creator" || member.status === "administrator";
    } catch {
      // getChatMember can fail for sentinel accounts or transient API
      // errors; deny instead of crashing the handler into silence.
      return false;
    }
  }

  return false;
}

/**
 * Decide whether the sender is authorized to receive workspace data at
 * all: a global admin or a user with an approved Kan account link.
 * Being an admin of some Telegram group is NOT enough — otherwise any
 * stranger could add the bot to their own group and subscribe to the
 * full workspace event stream.
 */
export async function isAuthorizedSubscriber(
  db: DbClient,
  adminIds: readonly number[],
  userId: number,
): Promise<boolean> {
  if (isGlobalAdmin(adminIds, userId)) return true;
  const mapping = await mappingRepo.getByTelegramUserId(db, userId);
  return mapping?.status === "approved";
}
