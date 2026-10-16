# Pulse Telegram inbox

The existing Telegram webhook can also store approved group messages for hourly
read-only collection by Pulse. The existing commands and Kan notifications retain
their handlers. Capture is disabled by default; it requires serverless mode and an
explicit `PULSE_TELEGRAM_CHAT_IDS` list.

For the verified deployment, the only approved value is:

```text
PULSE_TELEGRAM_CHAT_IDS=-1003976782755
```

This is the `Neary Skin Co.LTD` supergroup. The bot identity must remain
`8867888093` (`@neary_kan_bot`). Private chats are excluded in code, even if a
misconfiguration tries to allow one. This integration does not enable channels.

## Activation

1. Apply migrations `0001_pulse_telegram_inbox` and
   `0002_pulse_telegram_inbox_revision_index` using the existing Drizzle migration
   workflow. For deployments with `RUN_MIGRATIONS=false`, run migrations explicitly
   before enabling capture.
2. Apply `ops/pulse-reader.sql` as the table owner, then set the new reader role's
   login/password through the operator's secret workflow. Store its connection
   string only in Pulse's worker secret. The role has SELECT on the inbox only;
   its row policy limits reads to this bot and group.
3. Deploy the capture implementation with the allowlist above, preserving the
   existing service URL, webhook secret, commands, and Kan configuration.
4. Update the existing Telegram webhook registration with the same URL and secret.
   With capture enabled, `node dist/cli/telegram-webhook.js` in the production
   image (or `npm run telegram:webhook` in a source checkout) requests `message`
   and `edited_message`; it explicitly preserves pending updates. Do not replace this
   webhook with a second consumer or call `getUpdates`.

   Preserve `TELEGRAM_WEBHOOK_SECRET` when explicitly configured. Otherwise the
   existing value is HMAC-SHA256 of `telegram-webhook` using the unchanged bot
   token as the key. `WEBHOOK_SECRET` authenticates Kan deliveries separately.
5. The bot is currently a regular group member with privacy enabled. Its owner
   must disable Group Privacy in BotFather and remove/re-add the bot for ordinary
   group discussion to reach it. Preserve its existing group subscription.
6. Configure Pulse's `telegram_inbox` source, then verify a new message and its
   edit. Old group history is not fetched, and messages acknowledged by the old
   webhook before capture cannot be reconstructed from this inbox.

## Delivery and data boundary

After webhook-secret authentication, approved text/caption updates are normalized
into `public.pulse_telegram_inbox`. Full Telegram payloads, private messages,
attachments and replied-to messages are not stored. A transaction commits before
the webhook acknowledges receipt or invokes command handlers. Persistence failure
returns 503, leaving Telegram to retry. Replay inserts are deduplicated by
`(bot_id, update_id)`. Existing command-handler failures retain their previous
acknowledgement behavior after the capture has committed.

New messages and edits are separate immutable rows. Each bot's inserts acquire a
transaction advisory lock **before** sequence allocation. This preserves commit
order for the per-bot sequence cursor, including concurrent webhook requests.
Lock and statement timeouts bound database work. There is no automatic inbox
deletion in this release; any later retention policy must preserve uncollected
rows. Ordinary Telegram message deletion events are not available in this path.

## Pulse reader contract

Use a TLS-verified, read-only connection and parameterized SQL. Query one bot per
source; the database role additionally enforces the approved bot/group pair.

```sql
SELECT id, bot_id, update_id, chat_id, message_id, update_type,
       chat_title, chat_username, author_id, author_username, message_thread_id,
       body, occurred_at, received_at
FROM public.pulse_telegram_inbox
WHERE bot_id = :bot_id
  AND chat_id = ANY(:chat_ids)
  AND id > :after_id
ORDER BY id ASC
LIMIT :page_size;
```

`id` is BIGSERIAL; all Telegram IDs are BIGINT. Both timestamps are TIMESTAMPTZ.
`chat_username`, author fields and `message_thread_id` can be NULL. `body` is
bounded to 40,000 characters. The source entity key is `chat_id:message_id`, and
its revision is `update_id`; edits must not create an unrelated task anchor.
Commit imported evidence and the returned cursor in one Pulse transaction.
For each row, check whether a newer revision of the same bot/chat/message already
exists, ordered by `(occurred_at, update_id)`. Advance the cursor past superseded
rows without sending their older text to analysis. The revision index supports
this lookup, including delayed retries that arrive after an edit.
