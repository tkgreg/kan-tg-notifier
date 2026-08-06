import type { DbClient } from "../db/client.js";
import type { UserMapping } from "../db/schema.js";
import type { KanWebhookPayload } from "../kan/events.js";
import type { Logger } from "../logger.js";
import * as eventRepo from "../db/repository/event.repo.js";
import * as mappingRepo from "../db/repository/mapping.repo.js";
import * as subscriptionRepo from "../db/repository/subscription.repo.js";
import { NotificationDeliveryError } from "../telegram/notifier.js";
import { routeEventBatch } from "./routing.js";

/** Minimal notifier contract; satisfied by TelegramNotifier. */
export interface Notifier {
  sendHtmlMessage: (chatId: number, text: string) => Promise<void>;
}

export interface ProcessorDeps {
  db: DbClient;
  notifier: Notifier;
  logger: Logger;
  kanBaseUrl: string;
  /** Mention linked members' Telegram accounts in group messages. */
  groupMemberMentions: boolean;
}

/**
 * A basic group was upgraded to a supergroup while we were sending:
 * point the subscription at the new chat id and retry there once.
 */
async function redeliverToMigratedChat(
  deps: ProcessorDeps,
  text: string,
  oldChatId: number,
  newChatId: number,
): Promise<boolean> {
  const { db, notifier, logger } = deps;
  try {
    await subscriptionRepo.migrateChatId(db, oldChatId, newChatId);
    await notifier.sendHtmlMessage(newChatId, text);
    logger.info(
      { oldChatId, newChatId },
      "Chat migrated to supergroup; subscription updated and message redelivered",
    );
    return true;
  } catch (error) {
    logger.error(
      {
        oldChatId,
        newChatId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to redeliver to migrated chat",
    );
    return false;
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

/** A webhook event as stored in the event log, awaiting delivery. */
export interface StoredEvent {
  id: number;
  payload: KanWebhookPayload;
}

/**
 * Deliver notifications for a batch of stored webhook events concerning
 * one card and record the outcome on their event_log rows. The batch is
 * rendered as a single message per chat describing the card's resulting
 * state. Delivery failures for individual chats are collected instead of
 * aborting the whole batch.
 */
export async function processEventBatch(
  deps: ProcessorDeps,
  events: readonly StoredEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const { db, notifier, logger, kanBaseUrl } = deps;

  const payloads = events.map((event) => event.payload);
  const eventLogIds = events.map((event) => event.id);
  const eventNames = payloads.map((payload) => payload.event);

  const subscriptions = await subscriptionRepo.listAll(db);
  const memberMappings = await loadAffectedMemberMappings(db, payloads);
  const notifications = routeEventBatch(
    payloads,
    subscriptions,
    memberMappings,
    kanBaseUrl,
    { mentionLinkedMembers: deps.groupMemberMentions },
  );

  let sent = 0;
  const failures: string[] = [];

  for (const notification of notifications) {
    try {
      await notifier.sendHtmlMessage(notification.chatId, notification.text);
      sent += 1;
    } catch (error) {
      if (
        error instanceof NotificationDeliveryError &&
        error.migratedToChatId !== undefined
      ) {
        const delivered = await redeliverToMigratedChat(
          deps,
          notification.text,
          notification.chatId,
          error.migratedToChatId,
        );
        if (delivered) {
          sent += 1;
          continue;
        }
        failures.push(
          `Chat ${notification.chatId} migrated to ${error.migratedToChatId} but redelivery failed`,
        );
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      logger.error(
        {
          eventLogIds,
          events: eventNames,
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
        // Cleanup is best-effort: a DB error here must not abort
        // delivery to the remaining chats.
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
          failures.push(
            `Failed to remove subscription for unreachable chat ${notification.chatId}: ${cleanupMessage}`,
          );
          logger.error(
            { chatId: notification.chatId, error: cleanupMessage },
            "Failed to remove subscription for unreachable chat",
          );
        }
      }
    }
  }

  // The batch produced one set of notifications collectively, so every
  // row in it records the same outcome and the batch-wide sent count.
  if (failures.length > 0) {
    const errorText = failures.join("; ");
    for (const eventLogId of eventLogIds) {
      await eventRepo.markFailed(db, eventLogId, errorText, sent);
    }
    return;
  }

  for (const eventLogId of eventLogIds) {
    await eventRepo.markProcessed(db, eventLogId, sent);
  }
  logger.info(
    { eventLogIds, events: eventNames, notificationsSent: sent },
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
