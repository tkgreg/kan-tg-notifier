import { asc, eq, lt } from "drizzle-orm";

import type { KanWebhookPayload } from "../../kan/events.js";
import type { DbClient } from "../client.js";
import type { EventLogEntry } from "../schema.js";
import { eventLog } from "../schema.js";

/**
 * Store a received event. Returns undefined when a delivery with the same
 * raw-body hash was already stored (replayed or duplicated request).
 */
export async function insertReceived(
  db: DbClient,
  payload: KanWebhookPayload,
  payloadHash: string,
): Promise<number | undefined> {
  const rows = await db
    .insert(eventLog)
    .values({ event: payload.event, payload, payloadHash })
    .onConflictDoNothing({ target: eventLog.payloadHash })
    .returning({ id: eventLog.id });
  return rows[0]?.id;
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

/**
 * Events that were acknowledged but never processed, e.g. because the
 * process died before the queue drained. Ordered oldest first.
 */
export async function listUnprocessed(
  db: DbClient,
  limit: number,
): Promise<EventLogEntry[]> {
  return db
    .select()
    .from(eventLog)
    .where(eq(eventLog.status, "received"))
    .orderBy(asc(eventLog.id))
    .limit(limit);
}

/** Delete event log rows received before the cutoff. Returns the count. */
export async function deleteReceivedBefore(
  db: DbClient,
  cutoff: Date,
): Promise<number> {
  const rows = await db
    .delete(eventLog)
    .where(lt(eventLog.receivedAt, cutoff))
    .returning({ id: eventLog.id });
  return rows.length;
}
