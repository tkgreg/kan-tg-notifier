import type { DbClient } from "../db/client.js";
import type { UserMapping } from "../db/schema.js";
import type { KanWebhookPayload } from "../kan/events.js";
import type { Logger } from "../logger.js";
import type { Notification } from "./routing.js";
import type { CardThreadMessage, ThreadRegistry } from "./threads.js";
import * as eventRepo from "../db/repository/event.repo.js";
import * as mappingRepo from "../db/repository/mapping.repo.js";
import * as subscriptionRepo from "../db/repository/subscription.repo.js";
import { NotificationDeliveryError } from "../telegram/notifier.js";
import { routeDirectMessages, routeGroupMessages } from "./routing.js";

/** Minimal notifier contract; satisfied by TelegramNotifier. */
export interface Notifier {
  /** Send a message; resolves with the new Telegram message id. */
  sendHtmlMessage: (chatId: number, text: string) => Promise<number>;
  /** Replace the text of a previously sent message in place. */
  editHtmlMessage: (
    chatId: number,
    messageId: number,
    text: string,
  ) => Promise<void>;
}

export interface ProcessorDeps {
  db: DbClient;
  notifier: Notifier;
  logger: Logger;
  kanBaseUrl: string;
  /** Mention linked members' Telegram accounts in group messages. */
  groupMemberMentions: boolean;
  /**
   * Remembers the group messages already posted per card so follow-up
   * events edit them in place instead of posting new ones. Without it
   * every batch produces fresh messages.
   */
  threads?: ThreadRegistry;
}

/** A webhook event as stored in the event log, awaiting delivery. */
export interface StoredEvent {
  id: number;
  payload: KanWebhookPayload;
}

/** Safety valve: a card racking up this many events starts a new thread. */
const MAX_THREAD_EVENTS = 300;

/**
 * A basic group was upgraded to a supergroup while we were sending:
 * point the subscription at the new chat id and retry there once.
 * Resolves with the redelivered message's id, or undefined on failure.
 */
async function redeliverToMigratedChat(
  deps: ProcessorDeps,
  text: string,
  oldChatId: number,
  newChatId: number,
): Promise<number | undefined> {
  const { db, notifier, logger } = deps;
  try {
    await subscriptionRepo.migrateChatId(db, oldChatId, newChatId);
    const messageId = await notifier.sendHtmlMessage(newChatId, text);
    logger.info(
      { oldChatId, newChatId },
      "Chat migrated to supergroup; subscription updated and message redelivered",
    );
    return messageId;
  } catch (error) {
    logger.error(
      {
        oldChatId,
        newChatId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to redeliver to migrated chat",
    );
    return undefined;
  }
}

async function loadAffectedMemberMappings(
  db: DbClient,
  payloads: readonly KanWebhookPayload[],
): Promise<UserMapping[]> {
  const emails = new Set<string>();
  for (const payload of payloads) {
    const memberEmail = payload.data.member?.email;
    if (memberEmail) emails.add(memberEmail);
  }

  const mappings: UserMapping[] = [];
  for (const email of emails) {
    const mapping = await mappingRepo.getApprovedByEmail(db, email);
    if (mapping) mappings.push(mapping);
  }
  return mappings;
}

interface DeliveryState {
  sent: number;
  failures: string[];
}

/**
 * Record a delivery failure and, for group chats the bot can no longer
 * reach, drop the stale subscription. Cleanup is best-effort: a DB error
 * here must not abort delivery to the remaining chats.
 */
async function recordDeliveryFailure(
  deps: ProcessorDeps,
  notification: Notification,
  error: unknown,
  state: DeliveryState,
  logContext: Record<string, unknown>,
): Promise<void> {
  const { db, logger } = deps;
  const message = error instanceof Error ? error.message : String(error);
  state.failures.push(message);
  logger.error(
    {
      ...logContext,
      chatId: notification.chatId,
      kind: notification.kind,
      error: message,
    },
    "Failed to deliver notification",
  );

  if (
    error instanceof NotificationDeliveryError &&
    error.unreachableChat &&
    notification.kind === "group"
  ) {
    try {
      await subscriptionRepo.deleteByChatId(db, notification.chatId);
      logger.warn(
        { chatId: notification.chatId },
        "Removed subscription for unreachable chat",
      );
    } catch (cleanupError) {
      const cleanupMessage =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
      state.failures.push(
        `Failed to remove subscription for unreachable chat ${notification.chatId}: ${cleanupMessage}`,
      );
      logger.error(
        { chatId: notification.chatId, error: cleanupMessage },
        "Failed to remove subscription for unreachable chat",
      );
    }
  }
}

/**
 * Deliver notifications for a batch of stored webhook events concerning
 * one card and record the outcome on their event_log rows.
 *
 * The batch is rendered as a single card-state message per chat. When a
 * thread registry is present and this card was already reported within
 * the update window, the accumulated events are re-rendered and the
 * previously posted message is edited in place, so a chat always shows
 * one message with the card's current state. Direct messages are derived
 * from the new events only, never re-sent for already-reported ones.
 * Delivery failures for individual chats are collected instead of
 * aborting the whole batch.
 */
export async function processEventBatch(
  deps: ProcessorDeps,
  events: readonly StoredEvent[],
): Promise<void> {
  const first = events[0];
  if (!first) return;
  const { db, notifier, logger, kanBaseUrl } = deps;

  const cardPublicId = first.payload.data.card.publicId;
  const thread = deps.threads?.get(cardPublicId);
  const priorEvents =
    thread && thread.events.length < MAX_THREAD_EVENTS ? thread.events : [];
  const priorMessages = priorEvents.length > 0 ? thread?.messages : undefined;

  const allEvents = [...priorEvents, ...events];
  const newPayloads = events.map((event) => event.payload);
  const allPayloads = allEvents.map((event) => event.payload);
  const eventLogIds = events.map((event) => event.id);
  const eventNames = newPayloads.map((payload) => payload.event);
  const logContext = { eventLogIds, events: eventNames, cardPublicId };

  const subscriptions = await subscriptionRepo.listAll(db);
  const memberMappings = await loadAffectedMemberMappings(db, allPayloads);

  const directMessages = routeDirectMessages(
    newPayloads,
    memberMappings,
    kanBaseUrl,
  );
  const directChatIds = new Set(
    directMessages.map((notification) => notification.chatId),
  );
  const groupMessages = routeGroupMessages(
    allPayloads,
    subscriptions,
    memberMappings,
    kanBaseUrl,
    { mentionLinkedMembers: deps.groupMemberMentions },
    directChatIds,
  );

  const state: DeliveryState = { sent: 0, failures: [] };
  const messages = new Map<number, CardThreadMessage>(priorMessages ?? []);

  for (const notification of directMessages) {
    try {
      await notifier.sendHtmlMessage(notification.chatId, notification.text);
      state.sent += 1;
    } catch (error) {
      await recordDeliveryFailure(deps, notification, error, state, logContext);
    }
  }

  for (const notification of groupMessages) {
    const existing = messages.get(notification.chatId);
    if (existing?.text === notification.text) continue;

    if (existing) {
      try {
        await notifier.editHtmlMessage(
          notification.chatId,
          existing.messageId,
          notification.text,
        );
        messages.set(notification.chatId, {
          messageId: existing.messageId,
          text: notification.text,
        });
        state.sent += 1;
        continue;
      } catch (error) {
        // The earlier message may have been deleted or become too old to
        // edit; fall back to posting a fresh one.
        logger.warn(
          {
            chatId: notification.chatId,
            messageId: existing.messageId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Editing earlier card message failed; sending a new one",
        );
        messages.delete(notification.chatId);
      }
    }

    try {
      const messageId = await notifier.sendHtmlMessage(
        notification.chatId,
        notification.text,
      );
      messages.set(notification.chatId, {
        messageId,
        text: notification.text,
      });
      state.sent += 1;
    } catch (error) {
      if (
        error instanceof NotificationDeliveryError &&
        error.migratedToChatId !== undefined
      ) {
        const redeliveredId = await redeliverToMigratedChat(
          deps,
          notification.text,
          notification.chatId,
          error.migratedToChatId,
        );
        messages.delete(notification.chatId);
        if (redeliveredId !== undefined) {
          messages.set(error.migratedToChatId, {
            messageId: redeliveredId,
            text: notification.text,
          });
          state.sent += 1;
          continue;
        }
        state.failures.push(
          `Chat ${notification.chatId} migrated to ${error.migratedToChatId} but redelivery failed`,
        );
        continue;
      }

      await recordDeliveryFailure(deps, notification, error, state, logContext);
    }
  }

  deps.threads?.set(cardPublicId, { events: allEvents, messages });

  // The batch produced one set of notifications collectively, so every
  // row in it records the same outcome and the batch-wide sent count
  // (edits of earlier messages count as sent).
  if (state.failures.length > 0) {
    const errorText = state.failures.join("; ");
    for (const eventLogId of eventLogIds) {
      await eventRepo.markFailed(db, eventLogId, errorText, state.sent);
    }
    return;
  }

  for (const eventLogId of eventLogIds) {
    await eventRepo.markProcessed(db, eventLogId, state.sent);
  }
  logger.info(
    { ...logContext, notificationsSent: state.sent },
    "Webhook events processed",
  );
}

/** Single-event convenience wrapper around processEventBatch. */
export async function processEvent(
  deps: ProcessorDeps,
  eventLogId: number,
  payload: KanWebhookPayload,
): Promise<void> {
  await processEventBatch(deps, [{ id: eventLogId, payload }]);
}
