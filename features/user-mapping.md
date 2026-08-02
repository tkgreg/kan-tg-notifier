# OIDC user → Telegram mapping

Maps Kan (OIDC) user accounts, identified by email, to Telegram accounts. Kan webhooks carry the affected member's email (`data.member.email`), which is the join key.

## Flow

1. A user DMs the bot: `/link alice@corp.com`.
2. The mapping is stored as `pending` (table `user_mappings`, unique per Telegram user and per email).
3. Admins (from `ADMIN_TELEGRAM_IDS`) are notified and run `/approve alice@corp.com` or `/reject alice@corp.com`. With `AUTO_APPROVE_LINKS=true`, or when the requester is an admin, the link is approved immediately.
4. Approved users receive personal DMs when they are assigned to or removed from a card. Because the user opened the DM to send `/link`, the bot is always able to message them back.

## Security decisions

- Approval is required by default: without it, anyone able to message the bot could claim a colleague's email and receive that person's assignment notifications (card titles, boards).
- Emails are normalized (trimmed, lowercased) before storage and lookup.
- `/link`, `/unlink`, `/whoami` and all admin commands only work in private chats so emails never appear in group history.
- Only **approved** mappings are considered during notification routing.

## Commands

| Command | Who | Effect |
| --- | --- | --- |
| `/link <email>` | anyone, DM | Create a pending (or auto-approved) mapping |
| `/unlink` | owner, DM | Delete own mapping |
| `/whoami` | owner, DM | Show mapping status |
| `/approve <email>` | admin, DM | Approve a pending mapping and notify the user |
| `/reject <email>` | admin, DM | Delete a mapping and notify the user |
| `/mappings` | admin, DM | List all mappings |
