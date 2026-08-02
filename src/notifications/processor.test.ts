import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TestDb } from "../test-utils/pglite.js";
import type { Notifier, ProcessorDeps } from "./processor.js";
import * as mappingRepo from "../db/repository/mapping.repo.js";
import * as subscriptionRepo from "../db/repository/subscription.repo.js";
import * as eventRepo from "../db/repository/event.repo.js";
import { eventLog } from "../db/schema.js";
import { NotificationDeliveryError } from "../telegram/notifier.js";
import { buildPayload, TEST_KAN_BASE_URL } from "../test-utils/fixtures.js";
import { createSilentLogger } from "../test-utils/logger.js";
import { createTestDb } from "../test-utils/pglite.js";
import { processEvent } from "./processor.js";

interface SentMessage {
  chatId: number;
  text: string;
}

function createFakeNotifier(failFor: Map<number, Error> = new Map()): {
  notifier: Notifier;
  sent: SentMessage[];
} {
  const sent: SentMessage[] = [];
  return {
    sent,
    notifier: {
      sendHtmlMessage: (chatId, text) => {
        const failure = failFor.get(chatId);
        if (failure) return Promise.reject(failure);
        sent.push({ chatId, text });
        return Promise.resolve();
      },
    },
  };
}

describe("processEvent", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.close();
  });

  function depsWith(notifier: Notifier): ProcessorDeps {
    return {
      db: testDb.db,
      notifier,
      logger: createSilentLogger(),
      kanBaseUrl: TEST_KAN_BASE_URL,
    };
  }

  async function eventRow(id: number) {
    const rows = await testDb.db
      .select()
      .from(eventLog)
      .where(eq(eventLog.id, id));
    return rows[0];
  }

  it("sends to subscribed chats and marks the event processed", async () => {
    await subscriptionRepo.upsert(testDb.db, {
      chatId: -100,
      chatType: "supergroup",
      chatTitle: "Team",
      allEvents: true,
      events: [],
      createdBy: 111,
    });
    const { notifier, sent } = createFakeNotifier();
    const payload = buildPayload("card.created");
    const id = await eventRepo.insertReceived(testDb.db, payload);

    await processEvent(depsWith(notifier), id, payload);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(-100);
    expect(await eventRow(id)).toMatchObject({
      status: "processed",
      notificationsSent: 1,
    });
  });

  it("DMs the approved mapped member on card.member.added", async () => {
    await mappingRepo.create(testDb.db, {
      telegramUserId: 555,
      telegramUsername: "bob",
      kanEmail: "bob@corp.com",
      status: "approved",
    });
    const { notifier, sent } = createFakeNotifier();
    const payload = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const id = await eventRepo.insertReceived(testDb.db, payload);

    await processEvent(depsWith(notifier), id, payload);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(555);
    expect(sent[0]?.text).toContain("assigned you to");
  });

  it("does not DM a pending mapping", async () => {
    await mappingRepo.create(testDb.db, {
      telegramUserId: 555,
      telegramUsername: "bob",
      kanEmail: "bob@corp.com",
      status: "pending",
    });
    const { notifier, sent } = createFakeNotifier();
    const payload = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const id = await eventRepo.insertReceived(testDb.db, payload);

    await processEvent(depsWith(notifier), id, payload);
    expect(sent).toHaveLength(0);
  });

  it("marks the event failed when a delivery fails but still sends the rest", async () => {
    await subscriptionRepo.upsert(testDb.db, {
      chatId: -100,
      chatType: "supergroup",
      chatTitle: "Broken",
      allEvents: true,
      events: [],
      createdBy: 111,
    });
    await subscriptionRepo.upsert(testDb.db, {
      chatId: -200,
      chatType: "supergroup",
      chatTitle: "Working",
      allEvents: true,
      events: [],
      createdBy: 111,
    });
    const { notifier, sent } = createFakeNotifier(
      new Map([[-100, new Error("network down")]]),
    );
    const payload = buildPayload("card.created");
    const id = await eventRepo.insertReceived(testDb.db, payload);

    await processEvent(depsWith(notifier), id, payload);

    expect(sent.map((message) => message.chatId)).toEqual([-200]);
    const row = await eventRow(id);
    expect(row).toMatchObject({ status: "failed", notificationsSent: 1 });
    expect(row?.error).toContain("network down");
  });

  it("removes the subscription of a chat that blocked the bot", async () => {
    await subscriptionRepo.upsert(testDb.db, {
      chatId: -100,
      chatType: "supergroup",
      chatTitle: "Kicked from here",
      allEvents: true,
      events: [],
      createdBy: 111,
    });
    const { notifier } = createFakeNotifier(
      new Map([
        [
          -100,
          new NotificationDeliveryError("bot was kicked", {
            chatId: -100,
            attempts: 1,
            unreachableChat: true,
          }),
        ],
      ]),
    );
    const payload = buildPayload("card.created");
    const id = await eventRepo.insertReceived(testDb.db, payload);

    await processEvent(depsWith(notifier), id, payload);

    expect(await subscriptionRepo.getByChatId(testDb.db, -100)).toBeUndefined();
    expect(await eventRow(id)).toMatchObject({ status: "failed" });
  });
});
