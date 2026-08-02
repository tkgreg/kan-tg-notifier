import { eq } from "drizzle-orm";

import type { DbClient } from "../client.js";
import type { ChatSubscription } from "../schema.js";
import { chatSubscriptions } from "../schema.js";

export async function upsert(
  db: DbClient,
  input: {
    chatId: number;
    chatType: string;
    chatTitle: string | null;
    allEvents: boolean;
    events: string[];
    createdBy: number;
  },
): Promise<ChatSubscription> {
  const rows = await db
    .insert(chatSubscriptions)
    .values({
      chatId: input.chatId,
      chatType: input.chatType,
      chatTitle: input.chatTitle,
      allEvents: input.allEvents,
      events: input.events,
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: chatSubscriptions.chatId,
      set: {
        chatType: input.chatType,
        chatTitle: input.chatTitle,
        allEvents: input.allEvents,
        events: input.events,
        updatedAt: new Date(),
      },
    })
    .returning();

  const subscription = rows[0];
  if (!subscription) {
    throw new Error(`Failed to upsert subscription for chat ${input.chatId}`);
  }
  return subscription;
}

export async function getByChatId(
  db: DbClient,
  chatId: number,
): Promise<ChatSubscription | undefined> {
  const rows = await db
    .select()
    .from(chatSubscriptions)
    .where(eq(chatSubscriptions.chatId, chatId))
    .limit(1);
  return rows[0];
}

export async function setBoardFilter(
  db: DbClient,
  chatId: number,
  boardPublicIds: string[],
): Promise<ChatSubscription | undefined> {
  const rows = await db
    .update(chatSubscriptions)
    .set({ boardPublicIds, updatedAt: new Date() })
    .where(eq(chatSubscriptions.chatId, chatId))
    .returning();
  return rows[0];
}

export async function deleteByChatId(
  db: DbClient,
  chatId: number,
): Promise<ChatSubscription | undefined> {
  const rows = await db
    .delete(chatSubscriptions)
    .where(eq(chatSubscriptions.chatId, chatId))
    .returning();
  return rows[0];
}

export async function listAll(db: DbClient): Promise<ChatSubscription[]> {
  return db.select().from(chatSubscriptions);
}
