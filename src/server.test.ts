import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KanWebhookPayload } from "./kan/events.js";
import { computeSignature } from "./kan/signature.js";
import { createWebhookServer } from "./server.js";
import { buildPayload } from "./test-utils/fixtures.js";
import { createSilentLogger } from "./test-utils/logger.js";

const SECRET = "test-secret-at-least-16-chars";

describe("webhook server", () => {
  let server: FastifyInstance;
  let received: { payload: KanWebhookPayload; payloadHash: string }[];
  let seenHashes: Set<string>;

  beforeEach(() => {
    received = [];
    seenHashes = new Set();
    server = createWebhookServer({
      webhookSecret: SECRET,
      timestampToleranceSeconds: 0,
      logger: createSilentLogger(),
      onEvent: (payload, payloadHash) => {
        if (seenHashes.has(payloadHash)) return Promise.resolve("duplicate");
        seenHashes.add(payloadHash);
        received.push({ payload, payloadHash });
        return Promise.resolve("accepted");
      },
    });
  });

  afterEach(async () => {
    await server.close();
  });

  function signedRequest(body: string, overrides: Record<string, string> = {}) {
    return server.inject({
      method: "POST",
      url: "/webhook",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": computeSignature(Buffer.from(body), SECRET),
        ...overrides,
      },
    });
  }

  it("accepts a correctly signed payload with 202 and passes the body hash", async () => {
    const body = JSON.stringify(buildPayload("card.created"));
    const response = await signedRequest(body);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(received).toHaveLength(1);
    expect(received[0]?.payload.event).toBe("card.created");
    expect(received[0]?.payloadHash).toBe(
      createHash("sha256").update(body).digest("hex"),
    );
  });

  it("acknowledges a replayed delivery as a duplicate without reprocessing", async () => {
    const body = JSON.stringify(buildPayload("card.created"));
    await signedRequest(body);
    const replay = await signedRequest(body);

    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ status: "duplicate" });
    expect(received).toHaveLength(1);
  });

  it("rejects a missing signature with 401", async () => {
    const body = JSON.stringify(buildPayload("card.created"));
    const response = await server.inject({
      method: "POST",
      url: "/webhook",
      payload: body,
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("rejects a tampered body with 401", async () => {
    const body = JSON.stringify(buildPayload("card.created"));
    const tampered = body.replace("card.created", "card.deleted");
    const response = await server.inject({
      method: "POST",
      url: "/webhook",
      payload: tampered,
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": computeSignature(Buffer.from(body), SECRET),
      },
    });

    expect(response.statusCode).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("rejects a stale timestamp with 401 when tolerance is set", async () => {
    const staleServer = createWebhookServer({
      webhookSecret: SECRET,
      timestampToleranceSeconds: 600,
      logger: createSilentLogger(),
      onEvent: (payload, payloadHash) => {
        received.push({ payload, payloadHash });
        return Promise.resolve("accepted");
      },
    });
    const payload = buildPayload("card.created");
    payload.timestamp = "2020-01-01T00:00:00.000Z";
    const body = JSON.stringify(payload);
    const response = await staleServer.inject({
      method: "POST",
      url: "/webhook",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": computeSignature(Buffer.from(body), SECRET),
      },
    });

    expect(response.statusCode).toBe(401);
    expect(received).toHaveLength(0);
    await staleServer.close();
  });

  it("accepts a fresh timestamp when tolerance is set", async () => {
    const freshServer = createWebhookServer({
      webhookSecret: SECRET,
      timestampToleranceSeconds: 600,
      logger: createSilentLogger(),
      onEvent: (payload, payloadHash) => {
        received.push({ payload, payloadHash });
        return Promise.resolve("accepted");
      },
    });
    const payload = buildPayload("card.created");
    payload.timestamp = new Date().toISOString();
    const body = JSON.stringify(payload);
    const response = await freshServer.inject({
      method: "POST",
      url: "/webhook",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": computeSignature(Buffer.from(body), SECRET),
      },
    });

    expect(response.statusCode).toBe(202);
    expect(received).toHaveLength(1);
    await freshServer.close();
  });

  it("acknowledges unknown event types with 202 without processing them", async () => {
    const body = JSON.stringify({
      event: "card.exploded",
      timestamp: "2026-08-02T10:00:00.000Z",
      data: {},
    });
    const response = await signedRequest(body);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: "ignored" });
    expect(received).toHaveLength(0);
  });

  it("rejects a structurally invalid payload with 400", async () => {
    const body = JSON.stringify({
      event: "card.created",
      timestamp: "2026-08-02T10:00:00.000Z",
      data: {},
    });
    const response = await signedRequest(body);

    expect(response.statusCode).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("rejects invalid JSON with 400 when correctly signed", async () => {
    const response = await signedRequest("{not json");
    expect(response.statusCode).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("responds to the health check", async () => {
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
