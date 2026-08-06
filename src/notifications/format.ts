import type { KanChanges, KanWebhookPayload } from "../kan/events.js";

const MAX_TEXT_PREVIEW_LENGTH = 300;

/**
 * Telegram identity of the affected member, resolved through an approved
 * OIDC → Telegram mapping. When present, group messages mention the
 * concrete Telegram account instead of showing the Kan (OIDC) name.
 */
export interface MemberMention {
  telegramUserId: number;
  telegramUsername: string | null;
}

export interface FormatOptions {
  memberMention?: MemberMention;
}

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

function memberDisplayName(
  payload: KanWebhookPayload,
  mention: MemberMention | undefined,
): string {
  if (mention) {
    // An @username notifies the account when it is present in the chat;
    // the tg://user text mention works even without a public username.
    if (mention.telegramUsername) {
      return `@${escapeHtml(mention.telegramUsername)}`;
    }
    const label = payload.data.member?.name ?? "a member";
    return `<a href="tg://user?id=${mention.telegramUserId}">${escapeHtml(label)}</a>`;
  }

  const { member } = payload.data;
  if (!member) return "a member";
  if (member.name) return escapeHtml(member.name);
  // Group messages must not leak raw emails (members invited by email
  // have no display name yet); the masked form still identifies them.
  if (member.email) return escapeHtml(maskEmail(member.email));
  return "a member";
}

function headerLine(
  payload: KanWebhookPayload,
  kanBaseUrl: string,
  options: FormatOptions,
): string {
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
      return `👤 ${actor} assigned ${memberDisplayName(payload, options.memberMention)} to ${card}`;
    case "card.member.removed":
      return `👤 ${actor} removed ${memberDisplayName(payload, options.memberMention)} from ${card}`;
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
  options: FormatOptions = {},
): string {
  const lines: string[] = [headerLine(payload, kanBaseUrl, options)];

  const context = contextLine(payload);
  if (context) lines.push(context);

  if (
    payload.event === "card.comment.created" ||
    payload.event === "card.comment.updated"
  ) {
    const comment = payload.data.comment;
    if (comment)
      lines.push(`<blockquote>${textPreview(comment.text)}</blockquote>`);
  }

  if (
    (payload.event === "card.updated" || payload.event === "card.moved") &&
    payload.data.changes
  ) {
    lines.push(...formatChanges(payload.data.changes));
  }

  return lines.join("\n");
}

export interface BatchFormatOptions {
  /** Resolve a member's Telegram mention by their Kan email. */
  memberMentionFor?: (email: string) => MemberMention | undefined;
}

/** Net add/remove outcome for one member or label within a batch. */
export interface NetChange {
  /** The last event that touched the item in its surviving direction. */
  payload: KanWebhookPayload;
  /** Positive: added overall; negative: removed overall; never zero. */
  net: number;
}

/**
 * Net member additions/removals across a batch of events for one card.
 * A member added and removed within the same batch cancels out entirely.
 * Exported because routing derives direct messages from the same netting.
 */
export function netMemberChanges(
  payloads: readonly KanWebhookPayload[],
): NetChange[] {
  return netItemChanges(
    payloads,
    "card.member.added",
    "card.member.removed",
    (payload) => payload.data.member?.id,
  );
}

function netLabelChanges(payloads: readonly KanWebhookPayload[]): NetChange[] {
  return netItemChanges(
    payloads,
    "card.label.added",
    "card.label.removed",
    (payload) => payload.data.label?.id,
  );
}

function netItemChanges(
  payloads: readonly KanWebhookPayload[],
  addedEvent: KanWebhookPayload["event"],
  removedEvent: KanWebhookPayload["event"],
  keyOf: (payload: KanWebhookPayload) => string | undefined,
): NetChange[] {
  const byKey = new Map<
    string,
    {
      net: number;
      lastAdded?: KanWebhookPayload;
      lastRemoved?: KanWebhookPayload;
    }
  >();

  for (const payload of payloads) {
    if (payload.event !== addedEvent && payload.event !== removedEvent) {
      continue;
    }
    const key = keyOf(payload);
    if (key === undefined) continue;
    const entry = byKey.get(key) ?? { net: 0 };
    if (payload.event === addedEvent) {
      entry.net += 1;
      entry.lastAdded = payload;
    } else {
      entry.net -= 1;
      entry.lastRemoved = payload;
    }
    byKey.set(key, entry);
  }

  const changes: NetChange[] = [];
  for (const entry of byKey.values()) {
    const payload = entry.net > 0 ? entry.lastAdded : entry.lastRemoved;
    if (entry.net === 0 || !payload) continue;
    changes.push({ payload, net: entry.net });
  }
  return changes;
}

interface CommentOutcome {
  /** Latest payload carrying the comment's text. */
  payload: KanWebhookPayload;
  /** Whether the comment first appeared within this batch. */
  isNew: boolean;
}

interface BatchSummary {
  created: KanWebhookPayload | undefined;
  deleted: KanWebhookPayload | undefined;
  /** Last card.moved event; its list is the card's current list. */
  moved: KanWebhookPayload | undefined;
  /** Field changes merged across card.updated events (first from → last to). */
  changes: KanChanges;
  labels: NetChange[];
  members: NetChange[];
  /** Comments still existing at the end of the batch, latest text. */
  comments: CommentOutcome[];
  /** Pre-existing comments deleted within the batch. */
  deletedCommentCount: number;
}

function mergeChanges(payloads: readonly KanWebhookPayload[]): KanChanges {
  const merged: KanChanges = {};
  for (const payload of payloads) {
    if (payload.event !== "card.updated" && payload.event !== "card.moved") {
      continue;
    }
    for (const [key, change] of Object.entries(payload.data.changes ?? {})) {
      const existing = merged[key];
      merged[key] = existing
        ? { from: existing.from, to: change.to }
        : { from: change.from, to: change.to };
    }
  }
  // A value changed back and forth ends up unchanged: drop it.
  for (const [key, change] of Object.entries(merged)) {
    if (Object.is(change.from, change.to)) {
      delete merged[key];
    }
  }
  return merged;
}

function summarizeComments(payloads: readonly KanWebhookPayload[]): {
  comments: CommentOutcome[];
  deletedCommentCount: number;
} {
  const byId = new Map<
    string,
    { payload: KanWebhookPayload; isNew: boolean; deleted: boolean }
  >();
  let deletedUnknown = 0;

  for (const payload of payloads) {
    const comment = payload.data.comment;
    if (!comment) continue;
    const entry = byId.get(comment.id);

    if (payload.event === "card.comment.created") {
      byId.set(comment.id, { payload, isNew: true, deleted: false });
    } else if (payload.event === "card.comment.updated") {
      byId.set(comment.id, {
        payload,
        isNew: entry?.isNew ?? false,
        deleted: false,
      });
    } else if (payload.event === "card.comment.deleted") {
      if (entry?.isNew) {
        // Created and deleted within the batch: it never really existed.
        byId.delete(comment.id);
      } else if (entry) {
        entry.deleted = true;
      } else {
        deletedUnknown += 1;
      }
    }
  }

  const comments: CommentOutcome[] = [];
  let deletedCommentCount = deletedUnknown;
  for (const entry of byId.values()) {
    if (entry.deleted) {
      deletedCommentCount += 1;
      continue;
    }
    comments.push({ payload: entry.payload, isNew: entry.isNew });
  }
  return { comments, deletedCommentCount };
}

function summarizeCardBatch(
  payloads: readonly KanWebhookPayload[],
): BatchSummary {
  let created: KanWebhookPayload | undefined;
  let deleted: KanWebhookPayload | undefined;
  let moved: KanWebhookPayload | undefined;
  for (const payload of payloads) {
    if (payload.event === "card.created") created = payload;
    if (payload.event === "card.deleted") deleted = payload;
    if (payload.event === "card.moved") moved = payload;
  }

  return {
    created,
    deleted,
    moved,
    changes: mergeChanges(payloads),
    labels: netLabelChanges(payloads),
    members: netMemberChanges(payloads),
    ...summarizeComments(payloads),
  };
}

function combinedActor(payloads: readonly KanWebhookPayload[]): string {
  const names: string[] = [];
  for (const payload of payloads) {
    const name = payload.data.user?.name ?? "Someone";
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return "<b>Someone</b>";
  if (names.length === 1) return `<b>${escapeHtml(names[0] ?? "Someone")}</b>`;
  const last = names.pop() ?? "";
  return `<b>${names.map(escapeHtml).join(", ")} and ${escapeHtml(last)}</b>`;
}

function finalListName(
  payloads: readonly KanWebhookPayload[],
): string | undefined {
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    const list = payloads[i]?.data.list;
    if (list) return list.name;
  }
  return undefined;
}

function lastContextLine(
  payloads: readonly KanWebhookPayload[],
): string | undefined {
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    const payload = payloads[i];
    if (!payload) continue;
    const context = contextLine(payload);
    if (context) return context;
  }
  return undefined;
}

function mentionForMemberEvent(
  payload: KanWebhookPayload,
  options: BatchFormatOptions,
): MemberMention | undefined {
  const email = payload.data.member?.email;
  if (!email || !options.memberMentionFor) return undefined;
  return options.memberMentionFor(email);
}

function batchHeaderLine(
  summary: BatchSummary,
  actor: string,
  card: string,
  listName: string | undefined,
): string {
  const inList = listName ? ` in <i>${escapeHtml(listName)}</i>` : "";
  if (summary.created) return `🆕 ${actor} created ${card}${inList}`;
  if (summary.moved) {
    const toList = listName ? ` to <i>${escapeHtml(listName)}</i>` : "";
    return `📦 ${actor} moved ${card}${toList}`;
  }
  const onlyCommentActivity =
    Object.keys(summary.changes).length === 0 &&
    summary.labels.length === 0 &&
    summary.members.length === 0 &&
    (summary.comments.length > 0 || summary.deletedCommentCount > 0);
  if (onlyCommentActivity) return `💬 ${actor} commented on ${card}`;
  return `✏️ ${actor} updated ${card}`;
}

function batchDetailLines(
  summary: BatchSummary,
  options: BatchFormatOptions,
): string[] {
  const lines: string[] = [];

  // For a card created within the batch the current field values are
  // visible on the card itself; intermediate edits are noise.
  if (!summary.created) {
    lines.push(...formatChanges(summary.changes));
  }

  for (const change of summary.labels) {
    const verb = change.net > 0 ? "Added label" : "Removed label";
    lines.push(`🏷 ${verb} ${labelBadge(change.payload)}`);
  }

  for (const change of summary.members) {
    const mention = mentionForMemberEvent(change.payload, options);
    const name = memberDisplayName(change.payload, mention);
    const verb = change.net > 0 ? "Assigned" : "Removed";
    lines.push(`👤 ${verb} ${name}`);
  }

  for (const comment of summary.comments) {
    const text = comment.payload.data.comment?.text;
    if (text === undefined) continue;
    lines.push(comment.isNew ? "💬 Commented:" : "💬 Edited a comment:");
    lines.push(`<blockquote>${textPreview(text)}</blockquote>`);
  }
  if (summary.deletedCommentCount > 0) {
    lines.push(
      summary.deletedCommentCount === 1
        ? "💬 Deleted a comment"
        : `💬 Deleted ${summary.deletedCommentCount} comments`,
    );
  }

  return lines;
}

/**
 * Render a batch of webhook events for one card as a single Telegram HTML
 * message describing the card's resulting state. Actions that cancel out
 * within the batch (member or label added then removed, a field changed
 * back to its old value, a comment created then deleted) are omitted.
 * Returns undefined when everything cancelled out and there is nothing
 * left to say.
 */
export function formatCardBatchMessage(
  payloads: readonly KanWebhookPayload[],
  kanBaseUrl: string,
  options: BatchFormatOptions = {},
): string | undefined {
  const first = payloads[0];
  if (!first) return undefined;

  if (payloads.length === 1) {
    const memberMention = mentionForMemberEvent(first, options);
    return formatEventMessage(
      first,
      kanBaseUrl,
      memberMention ? { memberMention } : {},
    );
  }

  const summary = summarizeCardBatch(payloads);
  const latest = payloads[payloads.length - 1] ?? first;
  const actor = combinedActor(payloads);

  if (summary.deleted) {
    // The card is gone; whatever else happened first no longer matters.
    const card = cardLink(summary.deleted, kanBaseUrl);
    const verb = summary.created ? "created and deleted" : "deleted";
    const lines = [`🗑 ${actor} ${verb} ${card}`];
    const context = lastContextLine(payloads);
    if (context) lines.push(context);
    return lines.join("\n");
  }

  const details = batchDetailLines(summary, options);
  const hasHeaderAction =
    summary.created !== undefined || summary.moved !== undefined;
  if (!hasHeaderAction && details.length === 0) return undefined;

  const card = cardLink(latest, kanBaseUrl);
  const lines = [
    batchHeaderLine(summary, actor, card, finalListName(payloads)),
  ];
  const context = lastContextLine(payloads);
  if (context) lines.push(context);
  lines.push(...details);

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
