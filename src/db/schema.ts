import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const MAPPING_STATUSES = ["pending", "approved"] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

/**
 * Maps a Kan.bn (OIDC) user, identified by email, to a Telegram account.
 * Rows start as "pending" and must be approved by an admin unless
 * AUTO_APPROVE_LINKS is enabled.
 */
export const userMappings = pgTable(
  "user_mappings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" })
      .notNull()
      .unique(),
    telegramUsername: varchar("telegram_username", { length: 255 }),
    kanEmail: varchar("kan_email", { length: 255 }).notNull().unique(),
    status: varchar("status", { length: 16 })
      .$type<MappingStatus>()
      .notNull()
      .default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: bigint("approved_by", { mode: "number" }),
  },
  (table) => [index("user_mappings_status_idx").on(table.status)],
);

export type UserMapping = typeof userMappings.$inferSelect;
export type NewUserMapping = typeof userMappings.$inferInsert;

/**
 * A Telegram chat (group, supergroup, channel or private chat) subscribed
 * to Kan.bn webhook notifications, with optional event and board filters.
 */
export const chatSubscriptions = pgTable("chat_subscriptions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  chatId: bigint("chat_id", { mode: "number" }).notNull().unique(),
  chatType: varchar("chat_type", { length: 32 }).notNull(),
  chatTitle: varchar("chat_title", { length: 255 }),
  allEvents: boolean("all_events").notNull().default(true),
  events: text("events").array().notNull().default([]),
  boardPublicIds: text("board_public_ids").array().notNull().default([]),
  createdBy: bigint("created_by", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export type ChatSubscription = typeof chatSubscriptions.$inferSelect;
export type NewChatSubscription = typeof chatSubscriptions.$inferInsert;

export const EVENT_LOG_STATUSES = ["received", "processed", "failed"] as const;
export type EventLogStatus = (typeof EVENT_LOG_STATUSES)[number];

/**
 * Audit log of received webhook deliveries and their processing outcome.
 * payload_hash is the SHA-256 of the raw request body; its unique index
 * makes replayed deliveries (identical signed bytes) no-ops.
 */
export const eventLog = pgTable(
  "event_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    event: varchar("event", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 })
      .$type<EventLogStatus>()
      .notNull()
      .default("received"),
    notificationsSent: integer("notifications_sent").notNull().default(0),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    index("event_log_status_idx").on(table.status),
    uniqueIndex("event_log_payload_hash_idx").on(table.payloadHash),
  ],
);

export type EventLogEntry = typeof eventLog.$inferSelect;
