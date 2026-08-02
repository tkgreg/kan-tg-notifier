# Telegram notifications

Turns stored webhook events into Telegram messages.

## Routing (`src/notifications/routing.ts`, pure)

For each event:

1. **Personal DM** — on `card.member.added` / `card.member.removed`, if the affected member's email has an **approved** mapping (see `user-mapping.md`), the mapped Telegram user gets a personalized message ("Alice assigned you to …").
2. **Group messages** — every chat subscription whose event filter and board filter match gets the generic message.
3. A chat never receives both: the personal DM replaces the generic message for that chat ID.

## Formatting (`src/notifications/format.ts`, pure)

- Telegram HTML parse mode; all user content is escaped (`&`, `<`, `>`) and long text truncated (card titles 200 chars, comments 300 chars).
- The card title deep-links to `KAN_BASE_URL/cards/<publicId>`.
- Event-specific rendering: comments as `<blockquote>`, labels/members named in the header, `changes` of `card.updated` rendered as bullet lines (title from → to, "description updated", due date from → to). The `listId` change is covered by the `card.moved` header ("moved … to <list>").

## Delivery (`src/telegram/notifier.ts`)

`TelegramNotifier` is the connector class around the grammY `Api`:

- Retries up to 3 attempts on flood-wait (429, honouring `retry_after` up to 60s), 5xx and network errors, with structured warnings between attempts, then raises `NotificationDeliveryError`.
- 403 (bot blocked/kicked) raises immediately with `unreachableChat: true`; the processor then deletes that chat's subscription.
- Other 4xx errors are permanent and raise immediately.

The processor (`src/notifications/processor.ts`) sends notifications sequentially, collects per-chat failures without aborting the rest, and marks the `event_log` row `processed` or `failed`.
