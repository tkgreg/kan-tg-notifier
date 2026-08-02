import { and, eq } from "drizzle-orm";

import type { DbClient } from "../client.js";
import type { MappingStatus, UserMapping } from "../schema.js";
import { userMappings } from "../schema.js";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function getByTelegramUserId(
  db: DbClient,
  telegramUserId: number,
): Promise<UserMapping | undefined> {
  const rows = await db
    .select()
    .from(userMappings)
    .where(eq(userMappings.telegramUserId, telegramUserId))
    .limit(1);
  return rows[0];
}

export async function getByEmail(
  db: DbClient,
  email: string,
): Promise<UserMapping | undefined> {
  const rows = await db
    .select()
    .from(userMappings)
    .where(eq(userMappings.kanEmail, normalizeEmail(email)))
    .limit(1);
  return rows[0];
}

export async function getApprovedByEmail(
  db: DbClient,
  email: string,
): Promise<UserMapping | undefined> {
  const rows = await db
    .select()
    .from(userMappings)
    .where(
      and(
        eq(userMappings.kanEmail, normalizeEmail(email)),
        eq(userMappings.status, "approved"),
      ),
    )
    .limit(1);
  return rows[0];
}

export async function create(
  db: DbClient,
  input: {
    telegramUserId: number;
    telegramUsername: string | null;
    kanEmail: string;
    status: MappingStatus;
    approvedBy?: number;
  },
): Promise<UserMapping> {
  const now = new Date();
  const rows = await db
    .insert(userMappings)
    .values({
      telegramUserId: input.telegramUserId,
      telegramUsername: input.telegramUsername,
      kanEmail: normalizeEmail(input.kanEmail),
      status: input.status,
      approvedAt: input.status === "approved" ? now : null,
      approvedBy: input.status === "approved" ? (input.approvedBy ?? null) : null,
    })
    .returning();

  const mapping = rows[0];
  if (!mapping) {
    throw new Error(
      `Failed to create user mapping for email ${normalizeEmail(input.kanEmail)}`,
    );
  }
  return mapping;
}

export async function approveByEmail(
  db: DbClient,
  email: string,
  approvedBy: number,
): Promise<UserMapping | undefined> {
  const rows = await db
    .update(userMappings)
    .set({ status: "approved", approvedAt: new Date(), approvedBy })
    .where(
      and(
        eq(userMappings.kanEmail, normalizeEmail(email)),
        eq(userMappings.status, "pending"),
      ),
    )
    .returning();
  return rows[0];
}

export async function deleteByEmail(
  db: DbClient,
  email: string,
): Promise<UserMapping | undefined> {
  const rows = await db
    .delete(userMappings)
    .where(eq(userMappings.kanEmail, normalizeEmail(email)))
    .returning();
  return rows[0];
}

export async function deleteByTelegramUserId(
  db: DbClient,
  telegramUserId: number,
): Promise<UserMapping | undefined> {
  const rows = await db
    .delete(userMappings)
    .where(eq(userMappings.telegramUserId, telegramUserId))
    .returning();
  return rows[0];
}

export async function listAll(db: DbClient): Promise<UserMapping[]> {
  return db.select().from(userMappings).orderBy(userMappings.requestedAt);
}
