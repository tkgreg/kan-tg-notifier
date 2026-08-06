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

function labelBadge(payload: KanWebhookPayload): string {
  const { label } = payload.data;
  if (!label) return "<i>unknown</i>";
  return `<b>${escapeHtml(label.name)}</b>`;
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
  /** Whether any card.updated event is part of the batch. */
  updated: boolean;
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
  let updated = false;
  for (const payload of payloads) {
    if (payload.event === "card.created") created = payload;
    if (payload.event === "card.deleted") deleted = payload;
    if (payload.event === "card.moved") moved = payload;
    if (payload.event === "card.updated") updated = true;
  }

  return {
    created,
    deleted,
    moved,
    updated,
    changes: mergeChanges(payloads),
    labels: netLabelChanges(payloads),
    members: netMemberChanges(payloads),
    ...summarizeComments(payloads),
  };
}

function actorNames(payloads: readonly KanWebhookPayload[]): string {
  const names: string[] = [];
  for (const payload of payloads) {
    const name = payload.data.user?.name ?? "Someone";
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return "Someone";
  if (names.length === 1) return escapeHtml(names[0] ?? "Someone");
  const last = names.pop() ?? "";
  return `${names.map(escapeHtml).join(", ")} and ${escapeHtml(last)}`;
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

function finalBoardName(
  payloads: readonly KanWebhookPayload[],
): string | undefined {
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    const board = payloads[i]?.data.board;
    if (board) return board.name;
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

/** "2026-08-02T10:00:00.000Z" → "2026-08-02 10:00 UTC". */
function formatUpdatedAt(isoTimestamp: string): string | undefined {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function statusEmoji(summary: BatchSummary): string {
  if (summary.deleted) return "🗑";
  if (summary.created) return "🆕";
  if (summary.moved) return "📦";
  const onlyCommentActivity =
    !summary.updated &&
    summary.labels.length === 0 &&
    summary.members.length === 0 &&
    (summary.comments.length > 0 || summary.deletedCommentCount > 0);
  return onlyCommentActivity ? "💬" : "✏️";
}

/**
 * The Actions line names everything that net-happened within the batch,
 * in lifecycle order.
 */
function actionList(summary: BatchSummary): string[] {
  const actions: string[] = [];
  if (summary.created) actions.push("Created");
  if (summary.moved) actions.push("Moved");
  if (summary.updated) actions.push("Updated");
  if (summary.labels.some((change) => change.net > 0)) {
    actions.push("Label added");
  }
  if (summary.labels.some((change) => change.net < 0)) {
    actions.push("Label removed");
  }
  if (summary.members.some((change) => change.net > 0)) {
    actions.push("Assigned");
  }
  if (summary.members.some((change) => change.net < 0)) {
    actions.push("Unassigned");
  }
  if (summary.comments.some((comment) => comment.isNew)) {
    actions.push("Commented");
  }
  if (summary.comments.some((comment) => !comment.isNew)) {
    actions.push("Comment edited");
  }
  if (summary.deletedCommentCount > 0) actions.push("Comment deleted");
  if (summary.deleted) actions.push("Deleted");
  return actions;
}

function membersLine(
  summary: BatchSummary,
  options: BatchFormatOptions,
): string | undefined {
  if (summary.members.length === 0) return undefined;
  const parts = summary.members.map((change) => {
    const mention = mentionForMemberEvent(change.payload, options);
    const name = memberDisplayName(change.payload, mention);
    return change.net > 0 ? name : `${name} (removed)`;
  });
  return `<b>Members:</b> ${parts.join(", ")}`;
}

function labelsLine(summary: BatchSummary): string | undefined {
  if (summary.labels.length === 0) return undefined;
  const parts = summary.labels.map((change) => {
    const badge = labelBadge(change.payload);
    return change.net > 0 ? badge : `${badge} (removed)`;
  });
  return `<b>Labels:</b> ${parts.join(", ")}`;
}

function detailLines(summary: BatchSummary): string[] {
  const lines: string[] = [];
  if (summary.deleted) return lines;

  // For a card created within the batch the current field values are
  // visible on the card itself; intermediate edits are noise.
  if (!summary.created) {
    lines.push(...formatChanges(summary.changes));
  }

  for (const comment of summary.comments) {
    const text = comment.payload.data.comment?.text;
    if (text === undefined) continue;
    lines.push(comment.isNew ? "💬 Commented:" : "💬 Edited a comment:");
    lines.push(`<blockquote>${textPreview(text)}</blockquote>`);
  }

  return lines;
}

/**
 * Render a batch of webhook events for one card (a batch of one is the
 * common case) as a single Telegram HTML message describing the card's
 * resulting state:
 *
 *   🆕 Card title: <link>
 *   Board: …
 *   Column: …
 *   Members: …
 *   Updated at: …
 *   By: …
 *   Actions: Created, Assigned, …
 *
 * Actions that cancel out within the batch (member or label added then
 * removed, a field changed back to its old value, a comment created then
 * deleted) are omitted. Returns undefined when everything cancelled out
 * and there is nothing left to say.
 */
export function formatCardBatchMessage(
  payloads: readonly KanWebhookPayload[],
  kanBaseUrl: string,
  options: BatchFormatOptions = {},
): string | undefined {
  const first = payloads[0];
  if (!first) return undefined;

  const summary = summarizeCardBatch(payloads);
  const actions = actionList(summary);
  if (actions.length === 0) return undefined;

  const latest = payloads[payloads.length - 1] ?? first;
  // A deleted card's page no longer exists, so show the plain title.
  const card = summary.deleted
    ? `<b>${escapeHtml(truncate(latest.data.card.title, 200))}</b>`
    : cardLink(latest, kanBaseUrl);

  const lines: string[] = [
    `${statusEmoji(summary)} <b>Card title:</b> ${card}`,
  ];

  const board = finalBoardName(payloads);
  if (board) lines.push(`<b>Board:</b> ${escapeHtml(board)}`);
  const column = finalListName(payloads);
  if (column) lines.push(`<b>Column:</b> ${escapeHtml(column)}`);

  const members = membersLine(summary, options);
  if (members) lines.push(members);
  const labels = labelsLine(summary);
  if (labels) lines.push(labels);

  const updatedAt = formatUpdatedAt(latest.timestamp);
  if (updatedAt) lines.push(`<b>Updated at:</b> ${updatedAt}`);
  lines.push(`<b>By:</b> ${actorNames(payloads)}`);
  lines.push(`<b>Actions:</b> ${actions.join(", ")}`);

  lines.push(...detailLines(summary));

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
