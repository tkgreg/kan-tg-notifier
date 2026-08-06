import type { ChatSubscription, UserMapping } from "../db/schema.js";
import type { KanWebhookPayload } from "../kan/events.js";
import type { MemberMention } from "./format.js";
import { normalizeEmail } from "../db/repository/mapping.repo.js";
import {
  formatCardBatchMessage,
  formatMemberDirectMessage,
  netMemberChanges,
} from "./format.js";

export interface Notification {
  chatId: number;
  text: string;
  kind: "group" | "direct";
}

export interface RoutingOptions {
  /**
   * Replace the affected member's Kan (OIDC) name with a mention of
   * their linked Telegram account in group messages.
   */
  mentionLinkedMembers: boolean;
}

export function matchesSubscription(
  subscription: ChatSubscription,
  payload: KanWebhookPayload,
): boolean {
  const eventMatches =
    subscription.allEvents || subscription.events.includes(payload.event);
  const boardMatches =
    subscription.boardPublicIds.length === 0 ||
    subscription.boardPublicIds.includes(payload.data.card.boardId);
  return eventMatches && boardMatches;
}

function findApprovedMapping(
  email: string | undefined,
  approvedMappings: readonly UserMapping[],
): UserMapping | undefined {
  if (!email) return undefined;
  const normalized = normalizeEmail(email);
  return approvedMappings.find(
    (mapping) =>
      mapping.status === "approved" && mapping.kanEmail === normalized,
  );
}

/**
 * Personal direct messages for members whose net assignment changed
 * within the batch (an add+remove pair cancels out) and who have an
 * approved mapping.
 */
export function routeDirectMessages(
  payloads: readonly KanWebhookPayload[],
  approvedMappings: readonly UserMapping[],
  kanBaseUrl: string,
): Notification[] {
  const notifications: Notification[] = [];
  for (const change of netMemberChanges(payloads)) {
    const mapping = findApprovedMapping(
      change.payload.data.member?.email,
      approvedMappings,
    );
    if (!mapping) continue;
    notifications.push({
      chatId: mapping.telegramUserId,
      text: formatMemberDirectMessage(change.payload, kanBaseUrl),
      kind: "direct",
    });
  }
  return notifications;
}

/**
 * One card-state message per subscription whose event and board filters
 * match at least one event of the batch, each covering only the events
 * that passed that chat's filters. Chats in excludeChatIds (typically
 * chats receiving a personal DM instead) are skipped.
 */
export function routeGroupMessages(
  payloads: readonly KanWebhookPayload[],
  subscriptions: readonly ChatSubscription[],
  approvedMappings: readonly UserMapping[],
  kanBaseUrl: string,
  options: RoutingOptions = { mentionLinkedMembers: true },
  excludeChatIds: ReadonlySet<number> = new Set(),
): Notification[] {
  const notifications: Notification[] = [];

  const memberMentionFor = options.mentionLinkedMembers
    ? (email: string): MemberMention | undefined => {
        const mapping = findApprovedMapping(email, approvedMappings);
        if (!mapping) return undefined;
        return {
          telegramUserId: mapping.telegramUserId,
          telegramUsername: mapping.telegramUsername,
        };
      }
    : undefined;

  // Different subscriptions may filter the batch down to different
  // subsets; identical subsets share one formatted message.
  const textBySubset = new Map<string, string | undefined>();
  for (const subscription of subscriptions) {
    if (excludeChatIds.has(subscription.chatId)) continue;

    const includedIndexes: number[] = [];
    payloads.forEach((payload, index) => {
      if (matchesSubscription(subscription, payload)) {
        includedIndexes.push(index);
      }
    });
    if (includedIndexes.length === 0) continue;

    const subsetKey = includedIndexes.join(",");
    if (!textBySubset.has(subsetKey)) {
      const subset = includedIndexes.flatMap((index) => {
        const payload = payloads[index];
        return payload ? [payload] : [];
      });
      textBySubset.set(
        subsetKey,
        formatCardBatchMessage(
          subset,
          kanBaseUrl,
          memberMentionFor ? { memberMentionFor } : {},
        ),
      );
    }
    const text = textBySubset.get(subsetKey);
    if (text === undefined) continue;

    notifications.push({
      chatId: subscription.chatId,
      text,
      kind: "group",
    });
  }

  return notifications;
}

/**
 * Decide which Telegram chats must be notified about a batch of webhook
 * events concerning one card (a batch of one is the common case).
 *
 * Rules:
 * - Every subscription matching the event and board filters gets one
 *   group message summarizing the events that passed its filters. When
 *   an affected member has an approved mapping and mentionLinkedMembers
 *   is on, the message mentions their concrete Telegram account instead
 *   of the Kan (OIDC) name.
 * - Members whose net assignment changed (added or removed overall, after
 *   cancelling an add+remove pair within the batch) and who have an
 *   approved mapping get a personalized direct message instead of —
 *   never in addition to — the generic one.
 */
export function routeEventBatch(
  payloads: readonly KanWebhookPayload[],
  subscriptions: readonly ChatSubscription[],
  approvedMappings: readonly UserMapping[],
  kanBaseUrl: string,
  options: RoutingOptions = { mentionLinkedMembers: true },
): Notification[] {
  const directMessages = routeDirectMessages(
    payloads,
    approvedMappings,
    kanBaseUrl,
  );
  const directChatIds = new Set(
    directMessages.map((notification) => notification.chatId),
  );
  return [
    ...directMessages,
    ...routeGroupMessages(
      payloads,
      subscriptions,
      approvedMappings,
      kanBaseUrl,
      options,
      directChatIds,
    ),
  ];
}

/** Single-event convenience wrapper around routeEventBatch. */
export function routeEvent(
  payload: KanWebhookPayload,
  subscriptions: readonly ChatSubscription[],
  approvedMappings: readonly UserMapping[],
  kanBaseUrl: string,
  options: RoutingOptions = { mentionLinkedMembers: true },
): Notification[] {
  return routeEventBatch(
    [payload],
    subscriptions,
    approvedMappings,
    kanBaseUrl,
    options,
  );
}
