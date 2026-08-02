import type { KanChanges, KanWebhookPayload } from "../kan/events.js";

const MAX_TEXT_PREVIEW_LENGTH = 300;

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let cut = text.slice(0, maxLength - 1);
  // Never split a UTF-16 surrogate pair: a lone high surrogate would be
  // delivered as U+FFFD by Telegram.
  const lastCodeUnit = cut.charCodeAt(cut.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/**
 * Mask an email for display in group chats: emails must never be posted
 * verbatim outside of direct messages.
 */
export function maskEmail(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex < 1) return "a member";
  return `${email.slice(0, 1)}***@${email.slice(atIndex + 1)}`;
}

/**
 * Split lines into chunks that each fit within a Telegram message
 * (hard API limit: 4096 chars). Lines are never broken apart.
 */
export function chunkLines(lines: string[], maxLength: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    if (current.length === 0) {
      current = line;
      continue;
    }
    if (current.length + 1 + line.length > maxLength) {
      chunks.push(current);
      current = line;
      continue;
    }
    current = `${current}\n${line}`;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

function cardUrl(kanBaseUrl: string, cardPublicId: string): string {
  return `${kanBaseUrl}/cards/${cardPublicId}`;
}

function cardLink(payload: KanWebhookPayload, kanBaseUrl: string): string {
  const { card } = payload.data;
  const title = escapeHtml(truncate(card.title, 200));
  return `<a href="${cardUrl(kanBaseUrl, card.publicId)}">${title}</a>`;
}

function actorName(payload: KanWebhookPayload): string {
  return escapeHtml(payload.data.user?.name ?? "Someone");
}

function contextLine(payload: KanWebhookPayload): string | undefined {
  const { board, list } = payload.data;
  const parts: string[] = [];
  if (board) parts.push(escapeHtml(board.name));
  if (list) parts.push(escapeHtml(list.name));
  if (parts.length === 0) return undefined;
  return `📋 ${parts.join(" · ")}`;
}

function textPreview(text: string): string {
  return escapeHtml(truncate(text, MAX_TEXT_PREVIEW_LENGTH));
}

function formatDueDate(value: unknown): string {
  if (typeof value !== "string" && !(value instanceof Date)) return "none";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "none";
  return date.toISOString().slice(0, 10);
}

function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "string") return textPreview(truncate(value, 100));
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "…";
}

/**
 * Render the `changes` object of card.updated / card.moved events as
 * human-readable lines. The listId change is skipped: list moves are
 * already described by the message header.
 */
export function formatChanges(changes: KanChanges): string[] {
  const lines: string[] = [];

  const title = changes.title;
  if (title) {
    lines.push(
      `• Title: ${formatChangeValue(title.from)} → ${formatChangeValue(title.to)}`,
    );
  }
  if (changes.description) {
    lines.push("• Description updated");
  }
  const dueDate = changes.dueDate;
  if (dueDate) {
    lines.push(
      `• Due date: ${formatDueDate(dueDate.from)} → ${formatDueDate(dueDate.to)}`,
    );
  }

  return lines;
}

function memberDisplayName(payload: KanWebhookPayload): string {
  const { member } = payload.data;
  if (!member) return "a member";
  if (member.name) return escapeHtml(member.name);
  // Group messages must not leak raw emails (members invited by email
  // have no display name yet); the masked form still identifies them.
  if (member.email) return escapeHtml(maskEmail(member.email));
  return "a member";
}

function headerLine(payload: KanWebhookPayload, kanBaseUrl: string): string {
  const actor = `<b>${actorName(payload)}</b>`;
  const card = cardLink(payload, kanBaseUrl);
  const list = payload.data.list
    ? ` in <i>${escapeHtml(payload.data.list.name)}</i>`
    : "";

  switch (payload.event) {
    case "card.created":
      return `🆕 ${actor} created ${card}${list}`;
    case "card.updated":
      return `✏️ ${actor} updated ${card}`;
    case "card.moved":
      return `📦 ${actor} moved ${card}${list.replace(" in ", " to ")}`;
    case "card.deleted":
      return `🗑 ${actor} deleted ${card}`;
    case "card.comment.created":
      return `💬 ${actor} commented on ${card}`;
    case "card.comment.updated":
      return `💬 ${actor} edited a comment on ${card}`;
    case "card.comment.deleted":
      return `💬 ${actor} deleted a comment on ${card}`;
    case "card.label.added":
      return `🏷 ${actor} added label ${labelBadge(payload)} to ${card}`;
    case "card.label.removed":
      return `🏷 ${actor} removed label ${labelBadge(payload)} from ${card}`;
    case "card.member.added":
      return `👤 ${actor} assigned ${memberDisplayName(payload)} to ${card}`;
    case "card.member.removed":
      return `👤 ${actor} removed ${memberDisplayName(payload)} from ${card}`;
  }
}

function labelBadge(payload: KanWebhookPayload): string {
  const { label } = payload.data;
  if (!label) return "<i>unknown</i>";
  return `<b>${escapeHtml(label.name)}</b>`;
}

/**
 * Render a webhook payload as a Telegram HTML message for subscribed chats.
 */
export function formatEventMessage(
  payload: KanWebhookPayload,
  kanBaseUrl: string,
): string {
  const lines: string[] = [headerLine(payload, kanBaseUrl)];

  const context = contextLine(payload);
  if (context) lines.push(context);

  if (
    payload.event === "card.comment.created" ||
    payload.event === "card.comment.updated"
  ) {
    const comment = payload.data.comment;
    if (comment) lines.push(`<blockquote>${textPreview(comment.text)}</blockquote>`);
  }

  if (
    (payload.event === "card.updated" || payload.event === "card.moved") &&
    payload.data.changes
  ) {
    lines.push(...formatChanges(payload.data.changes));
  }

  return lines.join("\n");
}

/**
 * Render a personalized direct message for the member affected by a
 * card.member.added / card.member.removed event.
 */
export function formatMemberDirectMessage(
  payload: KanWebhookPayload,
  kanBaseUrl: string,
): string {
  const actor = `<b>${actorName(payload)}</b>`;
  const card = cardLink(payload, kanBaseUrl);
  const lines: string[] = [];

  if (payload.event === "card.member.added") {
    lines.push(`👋 ${actor} assigned you to ${card}`);
  } else {
    lines.push(`👋 ${actor} removed you from ${card}`);
  }

  const context = contextLine(payload);
  if (context) lines.push(context);

  return lines.join("\n");
}
