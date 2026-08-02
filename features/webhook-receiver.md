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
- Processing happens after the ack on a serial in-process queue (`src/notifications/queue.ts`), so delivery order matches event order and slow Telegram calls never hit Kan's 10s timeout.
- Every delivery is recorded in the `event_log` table with status `received` → `processed`/`failed`, the number of notifications sent, and the failure reason if any. On startup, rows still in `received` (acknowledged but unprocessed when the previous process died) are re-enqueued. Entries older than `EVENT_LOG_RETENTION_DAYS` are pruned daily.

## Error responses

| Case | Status |
| --- | --- |
| Missing/invalid/tampered signature | 401 |
| Stale signed timestamp | 401 |
| Unparseable JSON or invalid payload shape | 400 |
| Non-JSON content type | 415 |
| Unknown event type | 202 (ignored) |
| Replayed delivery (same body hash) | 202 (duplicate) |
