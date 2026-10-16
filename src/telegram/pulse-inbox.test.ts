import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";

import type { TestDb } from "../test-utils/pglite.js";
import { createTestDb } from "../test-utils/pglite.js";
import { pulseTelegramInbox } from "../db/schema.js";
import { capturePulseUpdate, parsePulseMessage } from "./pulse-inbox.js";

const BOT = 8867888093;
const CHAT = -1001234567890;
function update(id = 10) {
  return {
    update_id: id,
    message: {
      message_id: 2,
      date: 1792100000,
      text: "Investigate checkout failure",
      chat: { id: CHAT, type: "supergroup", title: "Engineering" },
      from: { id: 45, username: "dev", first_name: "Not stored" },
      reply_to_message: { text: "Unrelated prior context is not stored" },
    },
  };
}

describe("Pulse Telegram capture boundary", () => {
  it("is off by default and excludes other chats and private messages", () => {
    expect(parsePulseMessage(update(), BOT, [])).toBeUndefined();
    expect(parsePulseMessage(update(), BOT, [-100999])).toBeUndefined();
    const dm = update();
    dm.message.chat.type = "private";
    expect(parsePulseMessage(dm, BOT, [CHAT])).toBeUndefined();
  });

  it("keeps only the minimum text and identity fields", () => {
    const captured = parsePulseMessage(update(), BOT, [CHAT]);
    expect(captured).toMatchObject({
      botId: BOT,
      updateId: 10,
      chatId: CHAT,
      messageId: 2,
      body: "Investigate checkout failure",
      authorId: 45,
      authorUsername: "dev",
      updateType: "message",
    });
    expect(JSON.stringify(captured)).not.toContain("Not stored");
    expect(JSON.stringify(captured)).not.toContain("Unrelated prior context");
  });

  it("preserves edited captions, topic identity, and the edit timestamp", () => {
    const edited = {
      update_id: 11,
      edited_message: {
        message_id: 2,
        date: 1792100000,
        edit_date: 1792100060,
        message_thread_id: 7,
        caption: "Updated caption",
        chat: { id: CHAT, type: "supergroup", title: "Engineering" },
      },
    };
    expect(parsePulseMessage(edited, BOT, [CHAT])).toMatchObject({
      updateId: 11,
      messageId: 2,
      body: "Updated caption",
      updateType: "edited_message",
      messageThreadId: 7,
      occurredAt: new Date(1792100060000),
    });
  });

  it("does not retain malformed, oversized or non-text input", () => {
    const oversized = update();
    oversized.message.text = "x".repeat(40001);
    expect(parsePulseMessage(oversized, BOT, [CHAT])).toBeUndefined();
    expect(
      parsePulseMessage(
        { update_id: 1, message: { chat: { id: CHAT } } },
        BOT,
        [CHAT],
      ),
    ).toBeUndefined();
    expect(
      parsePulseMessage(
        { update_id: 1, callback_query: { data: "private" } },
        BOT,
        [CHAT],
      ),
    ).toBeUndefined();
  });
});

describe("Pulse Telegram durable inbox (real migrations)", () => {
  let testDb: TestDb;
  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(async () => {
    await testDb.close();
  });
  beforeEach(async () => {
    await testDb.db.delete(pulseTelegramInbox);
  });

  it("commits once per update and appends edits under the same message identity", async () => {
    await capturePulseUpdate(testDb.db, update(), BOT, [CHAT]);
    await capturePulseUpdate(testDb.db, update(), BOT, [CHAT]);
    const original = update();
    await capturePulseUpdate(
      testDb.db,
      {
        update_id: 11,
        edited_message: {
          ...original.message,
          text: "Issue resolved",
          edit_date: 1792100060,
        },
      },
      BOT,
      [CHAT],
    );
    const rows = await testDb.db
      .select()
      .from(pulseTelegramInbox)
      .orderBy(asc(pulseTelegramInbox.id));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.messageId)).toEqual([2, 2]);
    expect(rows.map((row) => row.updateId)).toEqual([10, 11]);
    expect(rows.map((row) => row.body)).toEqual([
      "Investigate checkout failure",
      "Issue resolved",
    ]);
    expect(rows[0]!.id < rows[1]!.id).toBe(true);
  });

  it("stores nothing outside the configured scope", async () => {
    await capturePulseUpdate(testDb.db, update(), BOT, []);
    await capturePulseUpdate(testDb.db, update(), BOT, [-100999]);
    expect(await testDb.db.select().from(pulseTelegramInbox)).toHaveLength(0);
  });
});
