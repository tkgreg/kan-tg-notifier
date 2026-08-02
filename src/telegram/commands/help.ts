import type { Context } from "grammy";

const HELP_TEXT = `<b>Kan.bn → Telegram notifier</b>

I deliver Kan.bn board activity to Telegram chats and map Kan (OIDC) accounts to Telegram accounts.

<b>Account linking (direct message only)</b>
/link email@example.com — link your Kan account
/unlink — remove your link
/whoami — show your link status

<b>Subscriptions (this chat)</b>
/subscribe — notify about all events
/subscribe card.created card.moved — only these events
/unsubscribe — stop notifications
/status — show this chat's subscription
/events — list available event types
/boards abc123def456 — only notify for these boards
/boards clear — remove the board filter
/boards — show the board filter

<b>Admin (direct message only)</b>
/approve email@example.com — approve a pending link
/reject email@example.com — reject a pending link
/mappings — list account links`;

export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
}
