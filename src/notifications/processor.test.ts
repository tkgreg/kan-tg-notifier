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
import { processEvent, processEventBatch } from "./processor.js";
import { createThreadRegistry } from "./threads.js";

interface SentMessage {
  chatId: number;
  text: string;
}

interface EditedMessage {
  chatId: number;
  messageId: number;
  text: string;
}

function createFakeNotifier(
  options: { failFor?: Map<number, Error>; failEdits?: boolean } = {},
): {
  notifier: Notifier;
  sent: SentMessage[];
  edited: EditedMessage[];
} {
  const sent: SentMessage[] = [];
  const edited: EditedMessage[] = [];
  let nextMessageId = 1000;
  return {
    sent,
    edited,
    notifier: {
      sendHtmlMessage: (chatId, text) => {
        const failure = options.failFor?.get(chatId);
        if (failure) return Promise.reject(failure);
        sent.push({ chatId, text });
        nextMessageId += 1;
        return Promise.resolve(nextMessageId);
      },
      editHtmlMessage: (chatId, messageId, text) => {
        if (options.failEdits) {
          return Promise.reject(
            new NotificationDeliveryError("message to edit not found", {
              chatId,
              attempts: 1,
              unreachableChat: false,
            }),
          );
        }
        edited.push({ chatId, messageId, text });
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

  let hashCounter = 0;
  async function storeEvent(
    payload: Parameters<typeof eventRepo.insertReceived>[1],
  ) {
    hashCounter += 1;
    const id = await eventRepo.insertReceived(
      testDb.db,
      payload,
      `hash-${hashCounter}`,
    );
    if (id === undefined)
      throw new Error("unexpected duplicate event in test setup");
    return id;
  }

  function depsWith(
    notifier: Notifier,
    threads?: ProcessorDeps["threads"],
  ): ProcessorDeps {
    return {
      db: testDb.db,
      notifier,
      logger: createSilentLogger(),
      kanBaseUrl: TEST_KAN_BASE_URL,
      groupMemberMentions: true,
      ...(threads ? { threads } : {}),
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
    const id = await storeEvent(payload);

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
    const id = await storeEvent(payload);

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
    const id = await storeEvent(payload);

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
    const { notifier, sent } = createFakeNotifier({
      failFor: new Map([[-100, new Error("network down")]]),
    });
    const payload = buildPayload("card.created");
    const id = await storeEvent(payload);

    await processEvent(depsWith(notifier), id, payload);

    expect(sent.map((message) => message.chatId)).toEqual([-200]);
    const row = await eventRow(id);
    expect(row).toMatchObject({ status: "failed", notificationsSent: 1 });
    expect(row?.error).toContain("network down");
  });

  it("follows a group-to-supergroup migration and redelivers", async () => {
    await subscriptionRepo.upsert(testDb.db, {
      chatId: -100,
      chatType: "group",
      chatTitle: "Upgraded",
      allEvents: true,
      events: [],
      createdBy: 111,
    });
    const { notifier, sent } = createFakeNotifier({
      failFor: new Map([
        [
          -100,
          new NotificationDeliveryError("group upgraded", {
            chatId: -100,
            attempts: 1,
            unreachableChat: false,
            migratedToChatId: -1005,
          }),
        ],
      ]),
    });
    const payload = buildPayload("card.created");
    const id = await storeEvent(payload);

    await processEvent(depsWith(notifier), id, payload);

    expect(sent.map((message) => message.chatId)).toEqual([-1005]);
    const migrated = await subscriptionRepo.getByChatId(testDb.db, -1005);
    expect(migrated).toBeDefined();
    expect(await subscriptionRepo.getByChatId(testDb.db, -100)).toBeUndefined();
    expect(await eventRow(id)).toMatchObject({
      status: "processed",
      notificationsSent: 1,
    });
  });

  it("sends one combined message for a batch and marks every event", async () => {
    await subscriptionRepo.upsert(testDb.db, {
      chatId: -100,
      chatType: "supergroup",
      chatTitle: "Team",
      allEvents: true,
      events: [],
      createdBy: 111,
    });
    await mappingRepo.create(testDb.db, {
      telegramUserId: 555,
      telegramUsername: "bob",
      kanEmail: "bob@corp.com",
      status: "approved",
    });
    const { notifier, sent } = createFakeNotifier();
    const created = buildPayload("card.created");
    const assigned = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const createdId = await storeEvent(created);
    const assignedId = await storeEvent(assigned);

    await processEventBatch(depsWith(notifier), [
      { id: createdId, payload: created },
      { id: assignedId, payload: assigned },
    ]);

    // One DM to the assignee plus one combined group message.
    expect(sent.map((message) => message.chatId).sort()).toEqual([-100, 555]);
    const group = sent.find((message) => message.chatId === -100);
    expect(group?.text).toContain("<b>Actions:</b> Created, Assigned");
    expect(group?.text).toContain("<b>Members:</b> @bob");
    expect(await eventRow(createdId)).toMatchObject({
      status: "processed",
      notificationsSent: 2,
    });
    expect(await eventRow(assignedId)).toMatchObject({
      status: "processed",
      notificationsSent: 2,
    });
  });

  it("edits the earlier message when follow-up events arrive within the window", async () => {
    await subscriptionRepo.upsert(testDb.db, {
      chatId: -100,
      chatType: "supergroup",
      chatTitle: "Team",
      allEvents: true,
      events: [],
      createdBy: 111,
    });
    const { notifier, sent, edited } = createFakeNotifier();
    const threads = createThreadRegistry(600_000);
    const deps = depsWith(notifier, threads);

    const created = buildPayload("card.created");
    const createdId = await storeEvent(created);
    await processEventBatch(deps, [{ id: createdId, payload: created }]);

    const assigned = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const assignedId = await storeEvent(assigned);
    await processEventBatch(deps, [{ id: assignedId, payload: assigned }]);

    // One original post, then an in-place edit instead of a second post.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("<b>Actions:</b> Created");
    expect(edited).toHaveLength(1);
    expect(edited[0]?.chatId).toBe(-100);
    expect(edited[0]?.text).toContain("<b>Actions:</b> Created, Assigned");
    expect(edited[0]?.text).toContain("<b>Members:</b> Bob");
    expect(await eventRow(assignedId)).toMatchObject({ status: "processed" });
  });

  it("does not repeat the DM for events already rendered in the thread", async () => {
    await mappingRepo.create(testDb.db, {
      telegramUserId: 555,
      telegramUsername: "bob",
      kanEmail: "bob@corp.com",
      status: "approved",
    });
    const { notifier, sent } = createFakeNotifier();
    const threads = createThreadRegistry(600_000);
    const deps = depsWith(notifier, threads);

    const assigned = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const assignedId = await storeEvent(assigned);
    await processEventBatch(deps, [{ id: assignedId, payload: assigned }]);

    const labeled = buildPayload("card.label.added", {
      label: { id: "label1234567", name: "Bug", colourCode: "#f00" },
    });
    const labeledId = await storeEvent(labeled);
    await processEventBatch(deps, [{ id: labeledId, payload: labeled }]);

    // Only the DM from the first batch; the label event triggers none.
    const dms = sent.filter((message) => message.chatId === 555);
    expect(dms).toHaveLength(1);
  });

  it("posts a new message once the update window has expired", async () => {
    await subscriptionRepo.upsert(testDb.db, {
      chatId: -100,
      chatType: "supergroup",
      chatTitle: "Team",
      allEvents: true,
      events: [],
      createdBy: 111,
    });
    const { notifier, sent, edited } = createFakeNotifier();
    let nowMs = 0;
    const threads = createThreadRegistry(600_000, () => nowMs);
    const deps = depsWith(notifier, threads);

    const created = buildPayload("card.created");
    const createdId = await storeEvent(created);
    await processEventBatch(deps, [{ id: createdId, payload: created }]);

    nowMs = 601_000;
    const assigned = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const assignedId = await storeEvent(assigned);
    await processEventBatch(deps, [{ id: assignedId, payload: assigned }]);

    expect(edited).toHaveLength(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain("<b>Actions:</b> Assigned");
    expect(sent[1]?.text).not.toContain("Created");
  });

  it("falls back to a new message when the edit fails", async () => {
    await subscriptionRepo.upsert(testDb.db, {
      chatId: -100,
      chatType: "supergroup",
      chatTitle: "Team",
      allEvents: true,
      events: [],
      createdBy: 111,
    });
    const { notifier, sent, edited } = createFakeNotifier({ failEdits: true });
    const threads = createThreadRegistry(600_000);
    const deps = depsWith(notifier, threads);

    const created = buildPayload("card.created");
    const createdId = await storeEvent(created);
    await processEventBatch(deps, [{ id: createdId, payload: created }]);

    const assigned = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const assignedId = await storeEvent(assigned);
    await processEventBatch(deps, [{ id: assignedId, payload: assigned }]);

    expect(edited).toHaveLength(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain("<b>Actions:</b> Created, Assigned");
    expect(await eventRow(assignedId)).toMatchObject({ status: "processed" });
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
    const { notifier } = createFakeNotifier({
      failFor: new Map([
        [
          -100,
          new NotificationDeliveryError("bot was kicked", {
            chatId: -100,
            attempts: 1,
            unreachableChat: true,
          }),
        ],
      ]),
    });
    const payload = buildPayload("card.created");
    const id = await storeEvent(payload);

    await processEvent(depsWith(notifier), id, payload);

    expect(await subscriptionRepo.getByChatId(testDb.db, -100)).toBeUndefined();
    expect(await eventRow(id)).toMatchObject({ status: "failed" });
  });
});
