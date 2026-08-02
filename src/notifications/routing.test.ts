import { describe, expect, it } from "vitest";

import {
  buildMapping,
  buildPayload,
  buildSubscription,
  TEST_KAN_BASE_URL,
} from "../test-utils/fixtures.js";
import { matchesSubscription, routeEvent } from "./routing.js";

describe("matchesSubscription", () => {
  it("matches any event when allEvents is set", () => {
    expect(
      matchesSubscription(buildSubscription(), buildPayload("card.deleted")),
    ).toBe(true);
  });

  it("matches only listed events otherwise", () => {
    const sub = buildSubscription({ allEvents: false, events: ["card.created"] });
    expect(matchesSubscription(sub, buildPayload("card.created"))).toBe(true);
    expect(matchesSubscription(sub, buildPayload("card.deleted"))).toBe(false);
  });

  it("applies the board filter", () => {
    const sub = buildSubscription({ boardPublicIds: ["otherboard12"] });
    expect(matchesSubscription(sub, buildPayload("card.created"))).toBe(false);

    const matching = buildSubscription({ boardPublicIds: ["board1234567"] });
    expect(matchesSubscription(matching, buildPayload("card.created"))).toBe(true);
  });
});

describe("routeEvent", () => {
  it("notifies every matching subscription", () => {
    const subs = [
      buildSubscription({ id: 1, chatId: -100 }),
      buildSubscription({ id: 2, chatId: -200, allEvents: false, events: ["card.created"] }),
      buildSubscription({ id: 3, chatId: -300, allEvents: false, events: ["card.deleted"] }),
    ];
    const notifications = routeEvent(
      buildPayload("card.created"),
      subs,
      [],
      TEST_KAN_BASE_URL,
    );
    expect(notifications.map((n) => n.chatId)).toEqual([-100, -200]);
    expect(notifications.every((n) => n.kind === "group")).toBe(true);
  });

  it("sends a personalized DM to the mapped member on card.member.added", () => {
    const payload = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "Bob@Corp.com" },
    });
    const notifications = routeEvent(
      payload,
      [],
      [buildMapping({ telegramUserId: 555, kanEmail: "bob@corp.com" })],
      TEST_KAN_BASE_URL,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ chatId: 555, kind: "direct" });
    expect(notifications[0]!.text).toContain("assigned you to");
  });

  it("mentions the linked member's Telegram account in group messages", () => {
    const payload = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const notifications = routeEvent(
      payload,
      [buildSubscription({ chatId: -100 })],
      [buildMapping({ telegramUserId: 555, telegramUsername: "bob_tg" })],
      TEST_KAN_BASE_URL,
    );
    const group = notifications.find((n) => n.chatId === -100);
    expect(group?.text).toContain("@bob_tg");
    expect(group?.text).not.toContain("assigned Bob to");
  });

  it("keeps the OIDC name in group messages when mentions are disabled", () => {
    const payload = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const notifications = routeEvent(
      payload,
      [buildSubscription({ chatId: -100 })],
      [buildMapping({ telegramUserId: 555, telegramUsername: "bob_tg" })],
      TEST_KAN_BASE_URL,
      { mentionLinkedMembers: false },
    );
    const group = notifications.find((n) => n.chatId === -100);
    expect(group?.text).toContain("assigned Bob to");
    expect(group?.text).not.toContain("@bob_tg");
  });

  it("does not double-send when the member's own chat is also subscribed", () => {
    const payload = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const notifications = routeEvent(
      payload,
      [
        buildSubscription({ id: 1, chatId: 555, chatType: "private" }),
        buildSubscription({ id: 2, chatId: -100 }),
      ],
      [buildMapping({ telegramUserId: 555 })],
      TEST_KAN_BASE_URL,
    );
    expect(notifications.map((n) => n.chatId).sort()).toEqual([-100, 555]);
    const direct = notifications.find((n) => n.chatId === 555);
    expect(direct?.kind).toBe("direct");
  });

  it("ignores mappings that are not approved", () => {
    const payload = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const notifications = routeEvent(
      payload,
      [],
      [buildMapping({ status: "pending" })],
      TEST_KAN_BASE_URL,
    );
    expect(notifications).toHaveLength(0);
  });

  it("does not DM mapped members for non-member events", () => {
    const payload = buildPayload("card.comment.created", {
      comment: { id: "cmnt12345678", text: "hi" },
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const notifications = routeEvent(
      payload,
      [],
      [buildMapping()],
      TEST_KAN_BASE_URL,
    );
    expect(notifications).toHaveLength(0);
  });

  it("returns nothing when no subscriptions or mappings match", () => {
    expect(
      routeEvent(buildPayload("card.created"), [], [], TEST_KAN_BASE_URL),
    ).toEqual([]);
  });
});
