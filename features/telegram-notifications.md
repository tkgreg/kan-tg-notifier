# Telegram notifications

Turns stored webhook events into Telegram messages.

## Aggregation (`src/notifications/aggregator.ts`)

Kan emits one webhook per elementary action, so a single user gesture (create a card, assign a member) arrives as several deliveries within moments. In persistent mode, events for the same card (keyed by `card.publicId`) are collected for `EVENT_AGGREGATION_SECONDS` (default 15, `0` disables) after the first one arrives — a fixed window, not a sliding one, so latency is bounded — and then processed as one batch. Shutdown flushes pending batches before the queue drains. Serverless mode processes each event immediately: an instance may be frozen between requests and cannot hold a timer.

## Routing (`src/notifications/routing.ts`, pure)

For each batch (a batch of one is the common case):

1. **Personal DM** — if a member's **net** assignment changed within the batch (`card.member.added` / `card.member.removed`, an add+remove pair cancels out) and their email has an **approved** mapping (see `user-mapping.md`), the mapped Telegram user gets a personalized message ("Alice assigned you to …").
2. **Group messages** — every chat subscription whose event filter and board filter match gets one combined message covering the events that passed its filters. When the affected member has an approved mapping and `GROUP_MEMBER_MENTIONS` is on (default), the message mentions their concrete Telegram account — `@username`, or a `tg://user?id=…` text mention when they have no public username — instead of the Kan (OIDC) display name.
3. A chat never receives both: the personal DM replaces the generic message for that chat ID.

## Card-state messages (`formatCardBatchMessage`)

Every group message — single event or aggregated batch — uses one uniform layout describing the card's **resulting state**:

```
🆕 Card title: <link>
Board: Engineering
Column: In Progress
Members: @bob
Labels: Bug
Updated at: 2026-08-02 10:00 UTC
By: Alice
Actions: Created, Assigned
```

The emoji reflects the primary action (🗑 deleted > 🆕 created > 📦 moved > 💬 comment-only > ✏️ everything else); the `Members:`/`Labels:` lines list net changes (removed items get a `(removed)` suffix); `Updated at:` is the last event's signed timestamp; `Actions:` names everything that net-happened. Detail lines follow when relevant: merged field changes (first `from` → last `to`, round-trips dropped) and surviving comments as blockquotes (latest text). A deleted card keeps the layout but loses its link and detail lines. When everything cancelled out (e.g. a label added and removed again), no message is sent at all.

## Formatting (`src/notifications/format.ts`, pure)

- Telegram HTML parse mode; all user content is escaped (`&`, `<`, `>`) and long text truncated without splitting surrogate pairs (card titles 200 chars, comments 300 chars). Member emails are masked (`b***@corp.com`) in group messages when the member has no display name.
- The card title deep-links to `KAN_BASE_URL/cards/<publicId>` (plain bold title when the card was deleted).
- Comments render as `<blockquote>`, `changes` of `card.updated` as bullet lines (title from → to, "description updated", due date from → to). The `listId` change is covered by the `Column:` line.

## Delivery (`src/telegram/notifier.ts`)

`TelegramNotifier` is the connector class around the grammY `Api`:

- Retries up to 3 attempts on flood-wait (429, honouring `retry_after` up to 60s), 5xx and network errors, with structured warnings between attempts, then raises `NotificationDeliveryError`.
- 403 (bot blocked/kicked) raises immediately with `unreachableChat: true`; the processor then deletes that chat's subscription (best-effort — a cleanup failure never blocks delivery to other chats).
- A 400 carrying `migrate_to_chat_id` (group upgraded to supergroup) raises with `migratedToChatId`; the processor moves the subscription to the new chat id and redelivers there.
- Other 4xx errors are permanent and raise immediately.

The processor (`src/notifications/processor.ts`) sends notifications sequentially, collects per-chat failures without aborting the rest, and marks the `event_log` row `processed` or `failed`.
