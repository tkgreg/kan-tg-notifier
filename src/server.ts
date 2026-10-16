import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";

import type { KanWebhookPayload } from "./kan/events.js";
import type { Logger } from "./logger.js";
import {
  isKanWebhookEvent,
  parseKanWebhookPayload,
  WebhookPayloadError,
} from "./kan/events.js";
import { isTimestampFresh, verifySignature } from "./kan/signature.js";
import { verifySecretToken } from "./telegram/secret-token.js";

/**
 * Kan imposes no length limit on card descriptions or comments, and a
 * comment edit carries the text three times (comment.text, changes.from,
 * changes.to), so Fastify's default 1 MiB limit could reject legitimate
 * deliveries with 413.
 */
const BODY_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * Receiving Telegram updates over HTTP instead of long polling. Only used
 * in serverless mode, where nothing keeps a getUpdates loop alive.
 */
export interface TelegramUpdatesDeps {
  path: string;
  /** Expected X-Telegram-Bot-Api-Secret-Token value. */
  secretToken: string;
  /** Optional durable capture; a failure must be retried before commands run. */
  captureUpdate?: (update: unknown) => Promise<void>;
  handleUpdate: (update: unknown) => Promise<void>;
}

export interface WebhookServerDeps {
  webhookSecret: string;
  timestampToleranceSeconds: number;
  logger: Logger;
  /**
   * Persist the event and schedule notification delivery. Must be fast.
   * payloadHash is the SHA-256 hex of the raw body; returns "duplicate"
   * when a delivery with the same hash was already stored.
   */
  onEvent: (
    payload: KanWebhookPayload,
    payloadHash: string,
  ) => Promise<"accepted" | "duplicate">;
  /** When set, Telegram updates are accepted on this route. */
  telegramUpdates?: TelegramUpdatesDeps;
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * HTTP server receiving Kan.bn webhook deliveries.
 *
 * Kan sends a single attempt with a 10s timeout and signs the raw JSON
 * body with HMAC-SHA256, so the route keeps the raw bytes for signature
 * verification and acknowledges quickly with 202 before notifications
 * are actually delivered.
 */
export function createWebhookServer(deps: WebhookServerDeps): FastifyInstance {
  const server = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });

  // Keep the raw body: the signature covers the exact bytes on the wire.
  server.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  server.get("/health", () => ({ status: "ok" }));

  const telegram = deps.telegramUpdates;
  if (telegram) {
    server.post(telegram.path, async (request, reply) => {
      const secretHeader = singleHeader(
        request.headers["x-telegram-bot-api-secret-token"],
      );
      if (!verifySecretToken(secretHeader, telegram.secretToken)) {
        deps.logger.warn(
          { hasSecretToken: secretHeader !== undefined },
          "Rejected Telegram update with missing or invalid secret token",
        );
        return reply.code(401).send({ error: "Invalid secret token" });
      }

      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) {
        return reply
          .code(415)
          .send({ error: "Expected an application/json body" });
      }

      let update: unknown;
      try {
        update = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return reply.code(400).send({ error: "Body is not valid JSON" });
      }

      try {
        await telegram.captureUpdate?.(update);
      } catch {
        // Do not log request bodies or database errors, which can contain text.
        deps.logger.error(
          "Telegram inbox persistence failed; delivery will be retried",
        );
        return reply
          .code(503)
          .send({ error: "Update persistence unavailable" });
      }

      try {
        await telegram.handleUpdate(update);
      } catch (error) {
        // Telegram retries a failed delivery for up to 24h, and an update
        // that throws once will throw again, so acknowledge it and leave
        // the diagnosis to the log.
        deps.logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Telegram update handler failed",
        );
      }
      return reply.code(200).send({ status: "ok" });
    });
  }

  server.post("/webhook", async (request, reply) => {
    const rawBody = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      return reply
        .code(415)
        .send({ error: "Expected an application/json body" });
    }

    const signatureHeader = singleHeader(
      request.headers["x-webhook-signature"],
    );
    if (!verifySignature(rawBody, signatureHeader, deps.webhookSecret)) {
      deps.logger.warn(
        { hasSignature: signatureHeader !== undefined },
        "Rejected webhook with missing or invalid signature",
      );
      return reply.code(401).send({ error: "Invalid webhook signature" });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "Body is not valid JSON" });
    }

    // Forward-compatibility: acknowledge event types added by newer Kan
    // versions instead of reporting a delivery failure to the sender.
    const eventField =
      typeof body === "object" && body !== null && "event" in body
        ? (body as { event: unknown }).event
        : undefined;
    if (typeof eventField === "string" && !isKanWebhookEvent(eventField)) {
      deps.logger.info({ event: eventField }, "Ignoring unknown event type");
      return reply.code(202).send({ status: "ignored" });
    }

    let payload: KanWebhookPayload;
    try {
      payload = parseKanWebhookPayload(body);
    } catch (error) {
      if (error instanceof WebhookPayloadError) {
        deps.logger.warn({ error: error.message }, "Rejected invalid payload");
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }

    if (
      !isTimestampFresh(
        payload.timestamp,
        deps.timestampToleranceSeconds,
        new Date(),
      )
    ) {
      deps.logger.warn(
        { event: payload.event, timestamp: payload.timestamp },
        "Rejected webhook with stale timestamp",
      );
      return reply.code(401).send({ error: "Stale webhook timestamp" });
    }

    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    const outcome = await deps.onEvent(payload, payloadHash);
    if (outcome === "duplicate") {
      deps.logger.info(
        { event: payload.event, payloadHash },
        "Ignoring replayed or duplicated delivery",
      );
      return reply.code(202).send({ status: "duplicate" });
    }
    return reply.code(202).send({ status: "accepted" });
  });

  return server;
}
