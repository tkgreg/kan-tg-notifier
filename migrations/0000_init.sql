CREATE TABLE "chat_subscriptions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"chat_type" varchar(32) NOT NULL,
	"chat_title" varchar(255),
	"all_events" boolean DEFAULT true NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"board_public_ids" text[] DEFAULT '{}' NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "chat_subscriptions_chat_id_unique" UNIQUE("chat_id")
);
--> statement-breakpoint
CREATE TABLE "event_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'received' NOT NULL,
	"notifications_sent" integer DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_mappings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"telegram_username" varchar(255),
	"kan_email" varchar(255) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" bigint,
	CONSTRAINT "user_mappings_telegram_user_id_unique" UNIQUE("telegram_user_id"),
	CONSTRAINT "user_mappings_kan_email_unique" UNIQUE("kan_email")
);
--> statement-breakpoint
CREATE INDEX "event_log_status_idx" ON "event_log" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "event_log_payload_hash_idx" ON "event_log" USING btree ("payload_hash");--> statement-breakpoint
CREATE INDEX "user_mappings_status_idx" ON "user_mappings" USING btree ("status");