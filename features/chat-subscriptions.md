# Chat subscriptions

Lets a Telegram chat (group, supergroup or private chat) receive Kan.bn notifications, with optional filters. Stored in the `chat_subscriptions` table, one row per chat.

## Commands

| Command | Effect |
| --- | --- |
| `/subscribe` | Subscribe the current chat to **all** events |
| `/subscribe card.created card.moved` | Subscribe to specific events only |
| `/unsubscribe` | Delete the subscription |
| `/status` | Show the current subscription |
| `/events` | List the 11 available event types |
| `/boards abc123def456 …` | Only notify for these board public IDs |
| `/boards clear` | Remove the board filter |
| `/boards` | Show the current filters |

## Rules

- Two independent checks gate every management command:
  1. **Chat-level rights** — in groups, the sender must be a Telegram chat administrator (checked via `getChatMember`; messages posted anonymously as the group count as admin) or a global bot admin. In private chats the user manages their own subscription. Channels are not supported.
  2. **Workspace-level authorization** — the sender must have an **approved** account link (see `user-mapping.md`) or be in `ADMIN_TELEGRAM_IDS`. Without this, any stranger could DM the bot (or add it to their own group) and receive the whole workspace event stream. Anonymous admins cannot be identified, so they must briefly disable *Remain anonymous* (or ask a bot admin).
- Re-running `/subscribe` updates the event filter but **preserves** the board filter.
- `allEvents=true` (the `/subscribe` default) also covers event types added by future Kan versions once the bot supports them.
- If Telegram reports the chat as unreachable during delivery (bot kicked/blocked, HTTP 403), the subscription is deleted automatically.
- When a basic group is upgraded to a supergroup, Telegram changes the chat id; the bot follows the `migrate_to_chat_id` service message (and the corresponding send error) and moves the subscription to the new id, redelivering the in-flight message.
