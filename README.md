# kan-tg-notifier

Telegram integration for [Kan.bn](https://kan.bn). The bot receives [workspace webhooks](https://github.com/tkgreg/kan) from a Kan instance and delivers board activity to Telegram users and groups. It also maps Kan (OIDC) users to Telegram accounts so people get personal notifications, e.g. when they are assigned to a card.

Built with TypeScript, PostgreSQL (Drizzle ORM), [grammY](https://grammy.dev) and Fastify.

## How it works

```mermaid
flowchart LR
    KAN[Kan.bn instance] -- "POST /webhook\nHMAC-SHA256 signed" --> SRV[Webhook server]
    SRV -- store + ack 202 --> DB[(PostgreSQL)]
    SRV --> Q[Serial queue]
    Q -- group messages --> TG[Telegram chats]
    Q -- personal DMs --> USR[Mapped users]
    BOT[Bot commands] -- subscriptions,\naccount links --> DB
```

1. In Kan, a workspace admin creates a webhook (Settings → Webhooks) pointing at this bot's `/webhook` endpoint with a shared secret.
2. Kan signs every delivery with `X-Webhook-Signature` (hex HMAC-SHA256 of the raw JSON body). The bot verifies the signature and the signed timestamp, stores the event in PostgreSQL, and acknowledges immediately with `202`.
3. Notifications are then delivered asynchronously, in event order:
   - **Group notifications** to every subscribed chat whose event/board filters match.
   - **Personal DMs** to the affected member on `card.member.added` / `card.member.removed`, looked up through the OIDC email → Telegram mapping.

### Supported events

All webhook events emitted by Kan: `card.created`, `card.updated`, `card.moved`, `card.deleted`, `card.comment.created`, `card.comment.updated`, `card.comment.deleted`, `card.label.added`, `card.label.removed`, `card.member.added`, `card.member.removed`.

Unknown event types from newer Kan versions are acknowledged and ignored, so the sender never records a delivery failure for them.

## Quick start (Docker Compose)

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Create a `.env` file next to `docker-compose.yml`:

   ```env
   TELEGRAM_BOT_TOKEN=123456:ABC...
   WEBHOOK_SECRET=<openssl rand -hex 32>
   KAN_BASE_URL=https://kan.example.com
   ADMIN_TELEGRAM_IDS=11111111
   POSTGRES_PASSWORD=<a real password>
   ```

3. Start it:

   ```sh
   docker compose up -d
   ```

4. Expose port `8080` through your HTTPS reverse proxy. Kan only accepts `https://` webhook URLs on public hosts, so the endpoint must be reachable as e.g. `https://kan-bot.example.com/webhook`.
5. In Kan: **Settings → Webhooks → Add webhook**, URL `https://kan-bot.example.com/webhook`, secret = your `WEBHOOK_SECRET`, and select the events you want.
6. Add the bot to a group (or open a DM with it) and send `/subscribe`.

Database migrations run automatically on startup.

## Bot commands

| Command | Where | Description |
| --- | --- | --- |
| `/help` | anywhere | Show help |
| `/link email@example.com` | DM | Link your Kan (OIDC) account by email |
| `/unlink` | DM | Remove your link |
| `/whoami` | DM | Show your link status |
| `/subscribe [event ...]` | group/DM | Notify this chat (all events when none given) |
| `/unsubscribe` | group/DM | Stop notifying this chat |
| `/status` | group/DM | Show this chat's subscription |
| `/events` | anywhere | List available event types |
| `/boards <id ...>` \| `clear` | group/DM | Filter notifications by board public IDs |
| `/approve email` | DM, admin | Approve a pending link request |
| `/reject email` | DM, admin | Reject/remove a link |
| `/mappings` | DM, admin | List all account links |

In groups, only chat administrators (and global admins from `ADMIN_TELEGRAM_IDS`) can manage the subscription. Board public IDs are the 12-character IDs from your Kan board URLs.

### OIDC user mapping

Kan webhooks identify affected members by the email of their (OIDC) user account. A user links their account by sending `/link their-oidc-email@example.com` to the bot in a DM. By default the link stays **pending** until an admin runs `/approve` — otherwise anyone could claim a colleague's email and receive their assignment notifications. Set `AUTO_APPROVE_LINKS=true` only in trusted environments.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | — | Bot token from @BotFather |
| `DATABASE_URL` | yes | — | PostgreSQL connection string |
| `WEBHOOK_SECRET` | yes | — | Shared secret, ≥16 chars; must match the secret configured in Kan |
| `KAN_BASE_URL` | yes | — | Base URL of your Kan instance, used for deep links |
| `HOST` | no | `0.0.0.0` | HTTP bind address |
| `PORT` | no | `8080` | HTTP port |
| `ADMIN_TELEGRAM_IDS` | no | empty | Comma-separated Telegram user IDs of bot admins |
| `AUTO_APPROVE_LINKS` | no | `false` | Approve `/link` requests without admin review |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | no | `600` | Reject payloads whose signed timestamp is older (replay protection); `0` disables |
| `LOG_LEVEL` | no | `info` | pino log level |

## Security notes

- Webhook deliveries are authenticated with a constant-time HMAC-SHA256 check over the raw body; unsigned or wrongly signed requests get `401`.
- The signed payload timestamp is checked against `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` to limit replays.
- `/link` requests require admin approval by default (see above).
- Admin commands and mapping listings only work in DMs so email addresses are never posted into groups.
- All user-provided content is HTML-escaped before it is sent to Telegram.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test          # includes PGlite-backed integration tests, no database needed
npm run dev       # start with tsx watch (requires a .env, see .env.example)
```

Migrations are generated from the Drizzle schema with `npm run db:generate` and live in `migrations/`. Feature documentation lives in [`features/`](features/).

## License

AGPL-3.0 — see [LICENSE](LICENSE).
