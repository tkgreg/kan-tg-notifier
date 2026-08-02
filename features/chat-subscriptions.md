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

- In groups, only Telegram chat administrators or global bot admins may manage the subscription (checked via `getChatMember`). In private chats the user manages their own subscription. Channels are not supported.
- Re-running `/subscribe` updates the event filter but **preserves** the board filter.
- `allEvents=true` (the `/subscribe` default) also covers event types added by future Kan versions once the bot supports them.
- If Telegram reports the chat as unreachable during delivery (bot kicked/blocked, HTTP 403), the subscription is deleted automatically.
