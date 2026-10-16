CREATE TABLE "pulse_telegram_inbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bot_id" bigint NOT NULL,
	"update_id" bigint NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"update_type" varchar(32) NOT NULL,
	"chat_title" text NOT NULL,
	"chat_username" varchar(255),
	"author_id" bigint,
	"author_username" varchar(255),
	"message_thread_id" bigint,
	"body" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pulse_telegram_inbox_bot_update_idx" ON "pulse_telegram_inbox" USING btree ("bot_id","update_id");--> statement-breakpoint
CREATE INDEX "pulse_telegram_inbox_bot_id_idx" ON "pulse_telegram_inbox" USING btree ("bot_id","id");