# Webhook receiver

Receives webhook deliveries from a Kan.bn instance and turns them into stored events.

## Contract with Kan

Kan (see `packages/api/src/utils/webhook.ts` in the [kan fork](https://github.com/tkgreg/kan)) sends:

- `POST` with a JSON body, single attempt, 10 second timeout, no retries.
- Headers: `X-Webhook-Event`, `X-Webhook-Timestamp`, and `X-Webhook-Signature` = hex HMAC-SHA256 of the raw body using the webhook's secret.
- Payload: `{ event, timestamp, data: { card, board?, list?, user?, comment?, label?, member?, changes? } }` where `user` is the acting Kan user (UUID + name) and `member` is the affected workspace member (public ID, name, email).

## Implementation

- `src/server.ts` — Fastify server (10 MiB body limit; Kan does not bound comment/description sizes). The JSON content-type parser keeps the **raw bytes** so the HMAC check covers exactly what was signed. Route flow: verify signature (constant-time, `src/kan/signature.ts`) → parse JSON → forward-compat check (unknown `event` strings are acknowledged with `202 {status:"ignored"}`) → validate payload shape with Zod (`src/kan/events.ts`) → check signed timestamp freshness → store event via `event.repo` → `202 {status:"accepted"}`.
- Replay protection beyond the timestamp window: the SHA-256 of the raw body is stored with a unique index, so a replayed delivery (identical signed bytes) is acknowledged with `202 {status:"duplicate"}` and produces no notifications.
- In `persistent` mode acknowledged events first pass through a per-card aggregation window (`src/notifications/aggregator.ts`, `EVENT_AGGREGATION_SECONDS`, default 15s) so bursts of events about one card become a single message, and processing then happens on a serial in-process queue (`src/notifications/queue.ts`), so delivery order matches flush order and slow Telegram calls never hit Kan's 10s timeout.
- In `serverless` mode (`RUNTIME_MODE=serverless`) the same work runs _inside_ the request, before the `202`, because the platform may freeze the CPU or stop the instance as soon as the response is flushed. Ordering then depends on how many deliveries the platform runs concurrently, and processing time counts against Kan's 10s timeout. Telegram updates arrive on `POST /telegram/updates`, authenticated by a constant-time check of the `X-Telegram-Bot-Api-Secret-Token` header (`src/telegram/secret-token.ts`) and always acknowledged with `200`, since Telegram would otherwise retry a permanently failing update for 24h.
- Every delivery is recorded in the `event_log` table with status `received` → `processed`/`failed`, the number of notifications sent, and the failure reason if any. Rows still in `received` (acknowledged but unprocessed when the previous process died) are re-enqueued on startup in `persistent` mode, or in a bounded batch once per instance in `serverless` mode. Entries older than `EVENT_LOG_RETENTION_DAYS` are pruned daily by a timer in `persistent` mode, and during that same once-per-instance pass in `serverless` mode.

## Error responses

| Case                                      | Status          |
| ----------------------------------------- | --------------- |
| Missing/invalid/tampered signature        | 401             |
| Stale signed timestamp                    | 401             |
| Unparseable JSON or invalid payload shape | 400             |
| Non-JSON content type                     | 415             |
| Unknown event type                        | 202 (ignored)   |
| Replayed delivery (same body hash)        | 202 (duplicate) |
