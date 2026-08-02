import type { ChatSubscription, UserMapping } from "../db/schema.js";
import type { KanWebhookPayload } from "../kan/events.js";
import { normalizeEmail } from "../db/repository/mapping.repo.js";
import { formatEventMessage, formatMemberDirectMessage } from "./format.js";

export interface Notification {
  chatId: number;
  text: string;
  kind: "group" | "direct";
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

const MEMBER_EVENTS: readonly KanWebhookPayload["event"][] = [
  "card.member.added",
  "card.member.removed",
];

function findAffectedMemberMapping(
  payload: KanWebhookPayload,
  approvedMappings: readonly UserMapping[],
): UserMapping | undefined {
  if (!MEMBER_EVENTS.includes(payload.event)) return undefined;

  const memberEmail = payload.data.member?.email;
  if (!memberEmail) return undefined;

  const normalized = normalizeEmail(memberEmail);
  return approvedMappings.find(
    (mapping) => mapping.status === "approved" && mapping.kanEmail === normalized,
  );
}

/**
 * Decide which Telegram chats must be notified about a webhook payload.
 *
 * Rules:
 * - Every subscription matching the event and board filters gets the
 *   generic group message.
 * - On card.member.added / card.member.removed, the affected member
 *   (looked up by their mapped Kan email) gets a personalized direct
 *   message instead of — never in addition to — the generic one.
 */
export function routeEvent(
  payload: KanWebhookPayload,
  subscriptions: readonly ChatSubscription[],
  approvedMappings: readonly UserMapping[],
  kanBaseUrl: string,
): Notification[] {
  const notifications: Notification[] = [];
  const directChatIds = new Set<number>();

  const memberMapping = findAffectedMemberMapping(payload, approvedMappings);
  if (memberMapping) {
    notifications.push({
      chatId: memberMapping.telegramUserId,
      text: formatMemberDirectMessage(payload, kanBaseUrl),
      kind: "direct",
    });
    directChatIds.add(memberMapping.telegramUserId);
  }

  const groupText = formatEventMessage(payload, kanBaseUrl);
  for (const subscription of subscriptions) {
    if (directChatIds.has(subscription.chatId)) continue;
    if (!matchesSubscription(subscription, payload)) continue;
    notifications.push({
      chatId: subscription.chatId,
      text: groupText,
      kind: "group",
    });
  }

  return notifications;
}
