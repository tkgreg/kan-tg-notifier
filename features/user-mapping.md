# OIDC user → Telegram mapping

Maps Kan (OIDC) user accounts, identified by email, to Telegram accounts. Kan webhooks carry the affected member's email (`data.member.email`), which is the join key.

## Flow

1. A user DMs the bot: `/link alice@corp.com`.
2. The mapping is stored as `pending` (table `user_mappings`, unique per Telegram user and per email).
3. Admins (from `ADMIN_TELEGRAM_IDS`) are notified and run `/approve alice@corp.com` or `/reject alice@corp.com`. With `AUTO_APPROVE_LINKS=true`, or when the requester is an admin, the link is approved immediately.
4. Approved users receive personal DMs when they are assigned to or removed from a card. Because the user opened the DM to send `/link`, the bot is always able to message them back.
5. In group notifications, approved users are shown as their concrete Telegram account (mention) instead of their Kan (OIDC) name, unless `GROUP_MEMBER_MENTIONS=false`.

## Security decisions

- Approval is required by default: without it, anyone able to message the bot could claim a colleague's email and receive that person's assignment notifications (card titles, boards).
- `/link` is enumeration-resistant: when approval is required, the reply is identical whether or not the email is already linked, and conflicts are reported only to admins (with a reminder to verify email ownership out of band before approving). In auto-approve/admin mode replies are honest, since that mode already assumes a trusted environment.
- Emails are normalized (trimmed, lowercased) before storage and lookup.
- `/link`, `/unlink`, `/whoami` and all admin commands only work in private chats so emails never appear in group history; group notifications mask emails (`b***@corp.com`) when a member has no display name.
- Only **approved** mappings are considered during notification routing.
- An approved mapping is also the prerequisite for subscribing chats (see `chat-subscriptions.md`).

## Commands

| Command | Who | Effect |
| --- | --- | --- |
| `/link <email>` | anyone, DM | Create a pending (or auto-approved) mapping |
| `/unlink` | owner, DM | Delete own mapping |
| `/whoami` | owner, DM | Show mapping status |
| `/approve <email>` | admin, DM | Approve a pending mapping and notify the user |
| `/reject <email>` | admin, DM | Delete a mapping and notify the user |
| `/mappings` | admin, DM | List all mappings |
