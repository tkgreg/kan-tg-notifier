import type { Context } from "grammy";

export function isGlobalAdmin(
  adminIds: readonly number[],
  userId: number,
): boolean {
  return adminIds.includes(userId);
}

/**
 * Decide whether the sender may manage the current chat's subscription:
 * anyone in their own private chat, chat admins and global admins in groups.
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
    if (isGlobalAdmin(adminIds, from.id)) return true;
    const member = await ctx.getChatMember(from.id);
    return member.status === "creator" || member.status === "administrator";
  }

  return false;
}
