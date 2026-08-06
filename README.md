# kan-tg-notifier

[![CI](https://github.com/tkgreg/kan-tg-notifier/actions/workflows/ci.yml/badge.svg)](https://github.com/tkgreg/kan-tg-notifier/actions/workflows/ci.yml)
[![Docker Hub](https://img.shields.io/docker/v/tkgreg/kan-tg-notifier?label=docker&sort=semver)](https://hub.docker.com/r/tkgreg/kan-tg-notifier)
[![Docker Pulls](https://img.shields.io/docker/pulls/tkgreg/kan-tg-notifier)](https://hub.docker.com/r/tkgreg/kan-tg-notifier)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

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
3. Notifications are then delivered in event order (asynchronously in `persistent` mode, before the webhook response in `serverless` mode — see [Runtime modes](#runtime-modes)):
   - **Group notifications** to every subscribed chat whose event/board filters match. When the affected member has a linked Telegram account, the message mentions it (`@username` or a profile link) instead of the Kan (OIDC) name — disable with `GROUP_MEMBER_MENTIONS=false`.
   - **Personal DMs** to the affected member on `card.member.added` / `card.member.removed`, looked up through the OIDC email → Telegram mapping.
4. Events about the same card become **one message describing the card's resulting state**. In `persistent` mode, events arriving within `EVENT_AGGREGATION_SECONDS` (default 15) are combined before sending; events arriving later — up to `MESSAGE_UPDATE_WINDOW_SECONDS` (default 10 minutes) after the message was last updated — **edit the already-posted message in place** instead of posting a new one. Creating a card and assigning a member half a minute later still ends up as a single message saying both. Actions that cancel out (a member added and removed again, a label toggled, a field changed back) are omitted entirely. Group messages use a uniform card-state layout:

   > 🆕 **Card title:** Fix the flux capacitor
   > **Board:** Engineering
   > **Column:** In Progress
   > **Members:** @bob
   > **Updated at:** 2026-08-02 10:00 UTC
   > **By:** Alice
   > **Actions:** Created, Assigned

### Supported events

All webhook events emitted by Kan: `card.created`, `card.updated`, `card.moved`, `card.deleted`, `card.comment.created`, `card.comment.updated`, `card.comment.deleted`, `card.label.added`, `card.label.removed`, `card.member.added`, `card.member.removed`.

Unknown event types from newer Kan versions are acknowledged and ignored, so the sender never records a delivery failure for them.

## Quick start (Docker Compose)

Prebuilt multi-arch images (`linux/amd64`, `linux/arm64`) are published to [Docker Hub](https://hub.docker.com/r/tkgreg/kan-tg-notifier) — no cloning or building required.

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Download the compose file (bot + PostgreSQL):

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/tkgreg/kan-tg-notifier/main/docker-compose.yml
   ```

3. Create a `.env` file next to `docker-compose.yml`:

   ```env
   TELEGRAM_BOT_TOKEN=123456:ABC...
   WEBHOOK_SECRET=<openssl rand -hex 32>
   KAN_BASE_URL=https://kan.example.com
   ADMIN_TELEGRAM_IDS=11111111
   # Optional: point the bot at an external PostgreSQL instead of the
   # bundled one (which is only reachable inside the compose network)
   # DATABASE_URL=postgres://user:password@db.example.com:5432/kan_tg_notifier
   ```

4. Start it:

   ```sh
   docker compose up -d
   ```

5. Expose port `8080` through your HTTPS reverse proxy. Kan only accepts `https://` webhook URLs on public hosts, so the endpoint must be reachable as e.g. `https://kan-bot.example.com/webhook`.
6. In Kan: **Settings → Webhooks → Add webhook**, URL `https://kan-bot.example.com/webhook`, secret = your `WEBHOOK_SECRET`, and select the events you want.
7. DM the bot `/link your-oidc-email@example.com` and approve it with `/approve` (as an admin). Then add the bot to a group (or stay in the DM) and send `/subscribe`.

Database migrations run automatically on startup, unless `RUN_MIGRATIONS=false`.

### Docker image

| Tag              | Meaning                                              |
| ---------------- | ---------------------------------------------------- |
| `latest`         | Most recent release                                  |
| `0.1`            | Latest patch release of the `0.1` line               |
| `0.1.0`          | Exact release, immutable — pin this in production    |

With an existing PostgreSQL you can skip Compose and run the container directly:

```sh
docker run -d --name kan-tg-notifier --restart unless-stopped \
  -e TELEGRAM_BOT_TOKEN=123456:ABC... \
  -e DATABASE_URL=postgres://user:password@db.example.com:5432/kan_tg_notifier \
  -e WEBHOOK_SECRET=change-me-16-chars-min \
  -e KAN_BASE_URL=https://kan.example.com \
  -p 8080:8080 \
  tkgreg/kan-tg-notifier:latest
```

## Runtime modes

`RUNTIME_MODE` picks how the process expects to be run:

|                          | `persistent` (default)                                   | `serverless`                                        |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------- |
| Telegram transport       | long polling (`getUpdates`)                              | webhook on `POST /telegram/updates`                 |
| Event processing         | acknowledged with `202`, delivered on a background queue | delivered before the `202` is sent                  |
| Log retention / recovery | `setInterval` sweep and startup recovery                 | once per instance, inside a request                 |
| Ordering across events   | strictly serial in-process                               | as serialized as the platform's request concurrency |

Use `persistent` for Docker Compose, a VM or anything else that keeps the
process alive. Use `serverless` where the platform is free to freeze the CPU
or stop the container between requests — a background queue would simply
never run there, and long polling stops the moment the instance goes away.

### Deploying to Cloud Run (scale to zero)

1. Apply migrations out of band so cold starts stay short:

   ```sh
   npm run db:migrate
   ```

2. Deploy with `RUNTIME_MODE=serverless`:

   ```sh
   gcloud run deploy kan-tg-notifier --source . \
     --region asia-southeast1 \
     --min-instances 0 --max-instances 1 --concurrency 1 --cpu-throttling \
     --port 8080 --allow-unauthenticated \
     --set-env-vars RUNTIME_MODE=serverless,RUN_MIGRATIONS=false,PUBLIC_URL=https://your-service-url
   ```

   `--max-instances 1 --concurrency 1` keeps deliveries serialized, which is
   what preserves event ordering. Raising either trades ordering for
   throughput.

3. Point Telegram at the service (also publishes the command list). This
   replaces long polling; it is a deploy-time step, not a startup step:

   ```sh
   PUBLIC_URL=https://your-service-url npm run telegram:webhook
   ```

   `npm run telegram:webhook -- --delete` reverts to long polling.

4. Register `https://your-service-url/webhook` in Kan as usual.

Kan allows a single delivery attempt with a 10s timeout and never retries, so
a cold start (container boot plus the database waking up) has to fit inside
that budget. If it does not, either keep `--min-instances 1` or add a
scheduled request to keep an instance warm. Events that were stored but not
delivered are retried on the next request either way.

## Bot commands

| Command                       | Where     | Description                                   |
| ----------------------------- | --------- | --------------------------------------------- |
| `/help`                       | anywhere  | Show help                                     |
| `/link email@example.com`     | DM        | Link your Kan (OIDC) account by email         |
| `/unlink`                     | DM        | Remove your link                              |
| `/whoami`                     | DM        | Show your link status                         |
| `/subscribe [event ...]`      | group/DM  | Notify this chat (all events when none given) |
| `/unsubscribe`                | group/DM  | Stop notifying this chat                      |
| `/status`                     | group/DM  | Show this chat's subscription                 |
| `/events`                     | anywhere  | List available event types                    |
| `/boards <id ...>` \| `clear` | group/DM  | Filter notifications by board public IDs      |
| `/approve email`              | DM, admin | Approve a pending link request                |
| `/reject email`               | DM, admin | Reject/remove a link                          |
| `/mappings`                   | DM, admin | List all account links                        |

Managing a subscription requires two things: chat-level rights (in groups, being a chat administrator — anonymous admins must briefly disable _Remain anonymous_) and workspace-level authorization (an **approved account link** via `/link`, or being listed in `ADMIN_TELEGRAM_IDS`). The second check stops strangers from subscribing themselves — or a group they created — to your workspace's event stream. Board public IDs are the 12-character IDs from your Kan board URLs.

### OIDC user mapping

Kan webhooks identify affected members by the email of their (OIDC) user account. A user links their account by sending `/link their-oidc-email@example.com` to the bot in a DM. By default the link stays **pending** until an admin runs `/approve` — otherwise anyone could claim a colleague's email and receive their assignment notifications. Set `AUTO_APPROVE_LINKS=true` only in trusted environments.

## Configuration

| Variable                              | Required        | Default                    | Description                                                                                                       |
| ------------------------------------- | --------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`                  | yes             | —                          | Bot token from @BotFather                                                                                         |
| `DATABASE_URL`                        | yes             | —                          | PostgreSQL connection string                                                                                      |
| `WEBHOOK_SECRET`                      | yes             | —                          | Shared secret, ≥16 chars; must match the secret configured in Kan                                                 |
| `KAN_BASE_URL`                        | yes             | —                          | Base URL of your Kan instance, used for deep links                                                                |
| `HOST`                                | no              | `0.0.0.0`                  | HTTP bind address                                                                                                 |
| `PORT`                                | no              | `8080`                     | HTTP port                                                                                                         |
| `RUNTIME_MODE`                        | no              | `persistent`               | `persistent` or `serverless`, see [Runtime modes](#runtime-modes)                                                 |
| `PUBLIC_URL`                          | in `serverless` | —                          | Public HTTPS base URL of this service, used to register the Telegram webhook                                      |
| `TELEGRAM_WEBHOOK_SECRET`             | no              | derived from the bot token | Secret token Telegram echoes back on update deliveries (16-256 chars of `A-Z a-z 0-9 _ -`)                        |
| `RUN_MIGRATIONS`                      | no              | `true`                     | Apply pending migrations on startup                                                                               |
| `ADMIN_TELEGRAM_IDS`                  | no              | empty                      | Comma-separated Telegram user IDs of bot admins                                                                   |
| `AUTO_APPROVE_LINKS`                  | no              | `false`                    | Approve `/link` requests without admin review                                                                     |
| `GROUP_MEMBER_MENTIONS`               | no              | `true`                     | Mention linked members' Telegram accounts in group messages instead of their OIDC names                           |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | no              | `600`                      | Reject payloads whose signed timestamp deviates more than this from server time (replay protection); `0` disables |
| `EVENT_AGGREGATION_SECONDS`           | no              | `15`                       | Collect events for the same card this long and send one combined message; `0` sends each event separately. Persistent mode only |
| `MESSAGE_UPDATE_WINDOW_SECONDS`       | no              | `600`                      | Edit the card's posted message in place when further events arrive within this window after its last update; `0` always posts new messages |
| `EVENT_LOG_RETENTION_DAYS`            | no              | `30`                       | Delete event log entries older than this; `0` keeps them forever                                                  |
| `LOG_LEVEL`                           | no              | `info`                     | pino log level                                                                                                    |

## Security notes

- Webhook deliveries are authenticated with a constant-time HMAC-SHA256 check over the raw body; unsigned or wrongly signed requests get `401`.
- The signed payload timestamp is checked against `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`, and replayed deliveries (identical signed bytes) are detected by a body-hash and acknowledged without effect.
- Subscribing a chat requires an approved account link or bot-admin status — Telegram-side group ownership alone grants nothing.
- `/link` requests require admin approval by default (see above), and `/link` replies do not reveal whether an email is already registered.
- Admin commands and mapping listings only work in DMs; group notifications mask email addresses (`b***@corp.com`) when a member has no display name.
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

### Releasing

Releases are cut from `main` by pushing a semver tag:

```sh
npm version patch   # or minor / major — bumps package.json and creates the vX.Y.Z tag
git push --follow-tags
```

The [release workflow](.github/workflows/release.yml) then re-runs all checks, verifies the tag matches `package.json`, builds the multi-arch image, pushes it to Docker Hub as `X.Y.Z`, `X.Y` and `latest`, and creates a GitHub release with generated notes. It needs the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets.

## License

AGPL-3.0 — see [LICENSE](LICENSE).
