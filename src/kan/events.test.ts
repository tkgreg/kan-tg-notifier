import { describe, expect, it } from "vitest";

import {
  isKanWebhookEvent,
  KAN_WEBHOOK_EVENTS,
  parseKanWebhookPayload,
  WebhookPayloadError,
} from "./events.js";

// Shaped exactly like kan's createCardWebhookPayload output after JSON
// serialization (undefined optionals are omitted on the wire).
const fullPayload = {
  event: "card.member.added",
  timestamp: "2026-08-02T10:00:00.000Z",
  data: {
    card: {
      id: "42",
      publicId: "card12345678",
      title: "Fix the flux capacitor",
      description: "It broke again",
      dueDate: "2026-08-10T00:00:00.000Z",
      listId: "list12345678",
      boardId: "board1234567",
    },
    board: { id: "board1234567", name: "Engineering" },
    list: { id: "list12345678", name: "In Progress" },
    user: { id: "b3b5ee12-0a70-4b52-a583-3f52802cd825", name: "Alice" },
    member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
  },
};

describe("parseKanWebhookPayload", () => {
  it("parses a full member event payload", () => {
    const payload = parseKanWebhookPayload(fullPayload);
    expect(payload.event).toBe("card.member.added");
    expect(payload.data.member?.email).toBe("bob@corp.com");
  });

  it("parses a minimal payload without optional objects", () => {
    const payload = parseKanWebhookPayload({
      event: "card.deleted",
      timestamp: "2026-08-02T10:00:00.000Z",
      data: {
        card: {
          id: "42",
          publicId: "card12345678",
          title: "A card",
          description: null,
          dueDate: null,
          listId: "list12345678",
          boardId: "board1234567",
        },
      },
    });
    expect(payload.data.board).toBeUndefined();
    expect(payload.data.user).toBeUndefined();
  });

  it("parses a card.updated payload with changes", () => {
    const payload = parseKanWebhookPayload({
      ...fullPayload,
      event: "card.updated",
      data: {
        ...fullPayload.data,
        changes: {
          title: { from: "Old", to: "New" },
          dueDate: { from: null, to: "2026-08-10T00:00:00.000Z" },
        },
      },
    });
    expect(payload.data.changes?.title).toEqual({ from: "Old", to: "New" });
  });

  it("parses an actor with a null name", () => {
    const payload = parseKanWebhookPayload({
      ...fullPayload,
      data: { ...fullPayload.data, user: { id: "abc", name: null } },
    });
    expect(payload.data.user?.name).toBeNull();
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      parseKanWebhookPayload({ ...fullPayload, event: "card.exploded" }),
    ).toThrow(WebhookPayloadError);
  });

  it("rejects a payload without a card", () => {
    expect(() =>
      parseKanWebhookPayload({
        event: "card.created",
        timestamp: "2026-08-02T10:00:00.000Z",
        data: {},
      }),
    ).toThrow(WebhookPayloadError);
  });

  it("rejects a non-object body", () => {
    expect(() => parseKanWebhookPayload("nope")).toThrow(WebhookPayloadError);
  });
});

describe("isKanWebhookEvent", () => {
  it("accepts every known event", () => {
    for (const event of KAN_WEBHOOK_EVENTS) {
      expect(isKanWebhookEvent(event)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isKanWebhookEvent("card.exploded")).toBe(false);
    expect(isKanWebhookEvent("")).toBe(false);
  });
});
