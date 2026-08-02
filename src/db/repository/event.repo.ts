import { eq } from "drizzle-orm";

import type { KanWebhookPayload } from "../../kan/events.js";
import type { DbClient } from "../client.js";
import { eventLog } from "../schema.js";

export async function insertReceived(
  db: DbClient,
  payload: KanWebhookPayload,
): Promise<number> {
  const rows = await db
    .insert(eventLog)
    .values({ event: payload.event, payload })
    .returning({ id: eventLog.id });

  const row = rows[0];
  if (!row) {
    throw new Error(`Failed to insert event log entry for ${payload.event}`);
  }
  return row.id;
}

export async function markProcessed(
  db: DbClient,
  id: number,
  notificationsSent: number,
): Promise<void> {
  await db
    .update(eventLog)
    .set({ status: "processed", notificationsSent, processedAt: new Date() })
    .where(eq(eventLog.id, id));
}

export async function markFailed(
  db: DbClient,
  id: number,
  error: string,
  notificationsSent: number,
): Promise<void> {
  await db
    .update(eventLog)
    .set({ status: "failed", error, notificationsSent, processedAt: new Date() })
    .where(eq(eventLog.id, id));
}
