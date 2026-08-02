import type { DbClient } from "../db/client.js";
import type { UserMapping } from "../db/schema.js";
import type { KanWebhookPayload } from "../kan/events.js";
import type { Logger } from "../logger.js";
import * as eventRepo from "../db/repository/event.repo.js";
import * as mappingRepo from "../db/repository/mapping.repo.js";
import * as subscriptionRepo from "../db/repository/subscription.repo.js";
import { NotificationDeliveryError } from "../telegram/notifier.js";
import { routeEvent } from "./routing.js";

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

async function loadAffectedMemberMapping(
  db: DbClient,
  payload: KanWebhookPayload,
): Promise<UserMapping | undefined> {
  const memberEmail = payload.data.member?.email;
  if (!memberEmail) return undefined;
  return mappingRepo.getApprovedByEmail(db, memberEmail);
}

/**
 * Deliver notifications for a stored webhook event and record the outcome
 * on its event_log row. Delivery failures for individual chats are
 * collected instead of aborting the whole event.
 */
export async function processEvent(
  deps: ProcessorDeps,
  eventLogId: number,
  payload: KanWebhookPayload,
): Promise<void> {
  const { db, notifier, logger, kanBaseUrl } = deps;

  const subscriptions = await subscriptionRepo.listAll(db);
  const memberMapping = await loadAffectedMemberMapping(db, payload);
  const notifications = routeEvent(
    payload,
    subscriptions,
    memberMapping ? [memberMapping] : [],
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
          eventLogId,
          event: payload.event,
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

  if (failures.length > 0) {
    await eventRepo.markFailed(db, eventLogId, failures.join("; "), sent);
    return;
  }

  await eventRepo.markProcessed(db, eventLogId, sent);
  logger.info(
    { eventLogId, event: payload.event, notificationsSent: sent },
    "Webhook event processed",
  );
}
