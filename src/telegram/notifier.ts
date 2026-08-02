import type { Api } from "grammy";
import { GrammyError, HttpError } from "grammy";

import type { Logger } from "../logger.js";

const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
const MAX_FLOOD_WAIT_SECONDS = 60;

export class NotificationDeliveryError extends Error {
  readonly chatId: number;
  readonly attempts: number;
  /** True when Telegram rejected the chat permanently (403: blocked/kicked). */
  readonly unreachableChat: boolean;

  constructor(
    message: string,
    options: {
      chatId: number;
      attempts: number;
      unreachableChat: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "NotificationDeliveryError";
    this.chatId = options.chatId;
    this.attempts = options.attempts;
    this.unreachableChat = options.unreachableChat;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RetryDecision {
  retry: boolean;
  delayMs: number;
  unreachableChat: boolean;
}

function decideRetry(error: unknown, attempt: number): RetryDecision {
  const backoffMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);

  if (error instanceof GrammyError) {
    if (error.error_code === 429) {
      const retryAfter = error.parameters.retry_after ?? 5;
      if (retryAfter > MAX_FLOOD_WAIT_SECONDS) {
        return { retry: false, delayMs: 0, unreachableChat: false };
      }
      return { retry: true, delayMs: retryAfter * 1000, unreachableChat: false };
    }
    if (error.error_code === 403) {
      return { retry: false, delayMs: 0, unreachableChat: true };
    }
    if (error.error_code >= 500) {
      return { retry: true, delayMs: backoffMs, unreachableChat: false };
    }
    // Remaining 4xx errors (bad request, chat not found, ...) are permanent.
    return { retry: false, delayMs: 0, unreachableChat: false };
  }

  if (error instanceof HttpError) {
    return { retry: true, delayMs: backoffMs, unreachableChat: false };
  }

  return { retry: false, delayMs: 0, unreachableChat: false };
}

/**
 * Connector to the Telegram Bot API for outgoing notifications.
 * Retries flood-wait (429), server (5xx) and network errors with warnings,
 * then raises the last error, as permanent failures raise immediately.
 */
export class TelegramNotifier {
  private readonly api: Api;
  private readonly logger: Logger;

  constructor(api: Api, logger: Logger) {
    this.api = api;
    this.logger = logger;
  }

  async sendHtmlMessage(chatId: number, text: string): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.api.sendMessage(chatId, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
        return;
      } catch (error) {
        lastError = error;
        const decision = decideRetry(error, attempt);

        if (!decision.retry || attempt === MAX_ATTEMPTS) {
          throw new NotificationDeliveryError(
            `Failed to send Telegram message to chat ${chatId} after ${attempt} attempt(s): ${
              error instanceof Error ? error.message : String(error)
            }`,
            {
              chatId,
              attempts: attempt,
              unreachableChat: decision.unreachableChat,
              cause: error,
            },
          );
        }

        this.logger.warn(
          {
            chatId,
            attempt,
            maxAttempts: MAX_ATTEMPTS,
            delayMs: decision.delayMs,
            error: error instanceof Error ? error.message : String(error),
          },
          "Telegram send failed, retrying",
        );
        await sleep(decision.delayMs);
      }
    }

    // Unreachable: the loop either returns or throws on the last attempt.
    throw new NotificationDeliveryError(
      `Failed to send Telegram message to chat ${chatId}`,
      {
        chatId,
        attempts: MAX_ATTEMPTS,
        unreachableChat: false,
        cause: lastError,
      },
    );
  }
}
