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

export interface WebhookServerDeps {
  webhookSecret: string;
  timestampToleranceSeconds: number;
  logger: Logger;
  /** Persist the event and schedule notification delivery. Must be fast. */
  onEvent: (payload: KanWebhookPayload) => Promise<void>;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
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
  const server = Fastify({ logger: false });

  // Keep the raw body: the signature covers the exact bytes on the wire.
  server.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  server.get("/health", () => ({ status: "ok" }));

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

    await deps.onEvent(payload);
    return reply.code(202).send({ status: "accepted" });
  });

  return server;
}
