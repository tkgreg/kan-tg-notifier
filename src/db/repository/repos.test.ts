import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TestDb } from "../../test-utils/pglite.js";
import { buildPayload } from "../../test-utils/fixtures.js";
import { createTestDb } from "../../test-utils/pglite.js";
import * as eventRepo from "./event.repo.js";
import * as mappingRepo from "./mapping.repo.js";
import * as subscriptionRepo from "./subscription.repo.js";

describe("repositories (PGlite with real migrations)", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  afterEach(async () => {
    await testDb.close();
  });

  describe("mapping.repo", () => {
    it("creates a pending mapping with a normalized email", async () => {
      const mapping = await mappingRepo.create(testDb.db, {
        telegramUserId: 555,
        telegramUsername: "bob",
        kanEmail: "  Bob@Corp.com ",
        status: "pending",
      });
      expect(mapping.kanEmail).toBe("bob@corp.com");
      expect(mapping.status).toBe("pending");
      expect(mapping.approvedAt).toBeNull();
    });

    it("finds mappings by telegram id and by email case-insensitively", async () => {
      await mappingRepo.create(testDb.db, {
        telegramUserId: 555,
        telegramUsername: null,
        kanEmail: "bob@corp.com",
        status: "pending",
      });
      expect(
        (await mappingRepo.getByTelegramUserId(testDb.db, 555))?.kanEmail,
      ).toBe("bob@corp.com");
      expect(
        (await mappingRepo.getByEmail(testDb.db, "BOB@corp.com"))?.telegramUserId,
      ).toBe(555);
    });

    it("approves only pending mappings and stamps the approver", async () => {
      await mappingRepo.create(testDb.db, {
        telegramUserId: 555,
        telegramUsername: null,
        kanEmail: "bob@corp.com",
        status: "pending",
      });

      const approved = await mappingRepo.approveByEmail(
        testDb.db,
        "bob@corp.com",
        111,
      );
      expect(approved?.status).toBe("approved");
      expect(approved?.approvedBy).toBe(111);
      expect(approved?.approvedAt).toBeInstanceOf(Date);

      // A second approval finds no pending row.
      expect(
        await mappingRepo.approveByEmail(testDb.db, "bob@corp.com", 111),
      ).toBeUndefined();
    });

    it("only returns approved mappings from getApprovedByEmail", async () => {
      await mappingRepo.create(testDb.db, {
        telegramUserId: 555,
        telegramUsername: null,
        kanEmail: "bob@corp.com",
        status: "pending",
      });
      expect(
        await mappingRepo.getApprovedByEmail(testDb.db, "bob@corp.com"),
      ).toBeUndefined();

      await mappingRepo.approveByEmail(testDb.db, "bob@corp.com", 111);
      expect(
        (await mappingRepo.getApprovedByEmail(testDb.db, "bob@corp.com"))?.status,
      ).toBe("approved");
    });

    it("enforces unique telegram ids and emails", async () => {
      await mappingRepo.create(testDb.db, {
        telegramUserId: 555,
        telegramUsername: null,
        kanEmail: "bob@corp.com",
        status: "approved",
      });
      await expect(
        mappingRepo.create(testDb.db, {
          telegramUserId: 555,
          telegramUsername: null,
          kanEmail: "other@corp.com",
          status: "pending",
        }),
      ).rejects.toThrow();
      await expect(
        mappingRepo.create(testDb.db, {
          telegramUserId: 777,
          telegramUsername: null,
          kanEmail: "bob@corp.com",
          status: "pending",
        }),
      ).rejects.toThrow();
    });

    it("deletes by telegram id and by email", async () => {
      await mappingRepo.create(testDb.db, {
        telegramUserId: 555,
        telegramUsername: null,
        kanEmail: "bob@corp.com",
        status: "approved",
      });
      const removed = await mappingRepo.deleteByTelegramUserId(testDb.db, 555);
      expect(removed?.kanEmail).toBe("bob@corp.com");
      expect(await mappingRepo.getByTelegramUserId(testDb.db, 555)).toBeUndefined();
    });
  });

  describe("subscription.repo", () => {
    const input = {
      chatId: -100,
      chatType: "supergroup",
      chatTitle: "Team",
      allEvents: true,
      events: [],
      createdBy: 111,
    };

    it("creates and updates a subscription via upsert", async () => {
      await subscriptionRepo.upsert(testDb.db, input);
      const updated = await subscriptionRepo.upsert(testDb.db, {
        ...input,
        allEvents: false,
        events: ["card.created"],
      });
      expect(updated.allEvents).toBe(false);
      expect(updated.events).toEqual(["card.created"]);
      expect(await subscriptionRepo.listAll(testDb.db)).toHaveLength(1);
    });

    it("preserves the board filter across re-subscribes", async () => {
      await subscriptionRepo.upsert(testDb.db, input);
      await subscriptionRepo.setBoardFilter(testDb.db, -100, ["board1234567"]);

      const resubscribed = await subscriptionRepo.upsert(testDb.db, input);
      expect(resubscribed.boardPublicIds).toEqual(["board1234567"]);
    });

    it("deletes a subscription and reports a missing one", async () => {
      await subscriptionRepo.upsert(testDb.db, input);
      expect(
        (await subscriptionRepo.deleteByChatId(testDb.db, -100))?.chatId,
      ).toBe(-100);
      expect(await subscriptionRepo.deleteByChatId(testDb.db, -100)).toBeUndefined();
    });

    it("returns undefined when setting a filter on a missing chat", async () => {
      expect(
        await subscriptionRepo.setBoardFilter(testDb.db, -999, ["x"]),
      ).toBeUndefined();
    });

    it("moves a subscription to the new chat id on migration", async () => {
      await subscriptionRepo.upsert(testDb.db, input);
      await subscriptionRepo.migrateChatId(testDb.db, -100, -1005);

      expect(await subscriptionRepo.getByChatId(testDb.db, -100)).toBeUndefined();
      const migrated = await subscriptionRepo.getByChatId(testDb.db, -1005);
      expect(migrated?.chatType).toBe("supergroup");
      expect(migrated?.allEvents).toBe(true);
    });

    it("drops the stale row when the new chat id already has a subscription", async () => {
      await subscriptionRepo.upsert(testDb.db, input);
      await subscriptionRepo.upsert(testDb.db, {
        ...input,
        chatId: -1005,
        allEvents: false,
        events: ["card.created"],
      });

      await subscriptionRepo.migrateChatId(testDb.db, -100, -1005);

      expect(await subscriptionRepo.getByChatId(testDb.db, -100)).toBeUndefined();
      const kept = await subscriptionRepo.getByChatId(testDb.db, -1005);
      expect(kept?.events).toEqual(["card.created"]);
    });
  });

  describe("event.repo", () => {
    it("stores an event and marks it processed", async () => {
      const payload = buildPayload("card.created");
      const id = await eventRepo.insertReceived(testDb.db, payload, "hash-a");
      expect(id).toBeDefined();
      await eventRepo.markProcessed(testDb.db, id!, 3);

      const rows = await testDb.db.query.eventLog.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event: "card.created",
        status: "processed",
        notificationsSent: 3,
      });
      expect(rows[0]?.processedAt).toBeInstanceOf(Date);
    });

    it("marks an event failed with the error message", async () => {
      const id = await eventRepo.insertReceived(
        testDb.db,
        buildPayload("card.deleted"),
        "hash-b",
      );
      await eventRepo.markFailed(testDb.db, id!, "chat unreachable", 1);

      const rows = await testDb.db.query.eventLog.findMany();
      expect(rows[0]).toMatchObject({
        status: "failed",
        error: "chat unreachable",
        notificationsSent: 1,
      });
    });

    it("returns undefined for a duplicate payload hash instead of a second row", async () => {
      const payload = buildPayload("card.created");
      const first = await eventRepo.insertReceived(testDb.db, payload, "same-hash");
      const replay = await eventRepo.insertReceived(testDb.db, payload, "same-hash");

      expect(first).toBeDefined();
      expect(replay).toBeUndefined();
      expect(await testDb.db.query.eventLog.findMany()).toHaveLength(1);
    });

    it("lists only unprocessed events, oldest first", async () => {
      const first = await eventRepo.insertReceived(
        testDb.db,
        buildPayload("card.created"),
        "hash-1",
      );
      const second = await eventRepo.insertReceived(
        testDb.db,
        buildPayload("card.updated"),
        "hash-2",
      );
      await eventRepo.insertReceived(testDb.db, buildPayload("card.moved"), "hash-3");
      await eventRepo.markProcessed(testDb.db, second!, 1);

      const pending = await eventRepo.listUnprocessed(testDb.db, 10);
      expect(pending.map((entry) => entry.event)).toEqual([
        "card.created",
        "card.moved",
      ]);
      expect(pending[0]?.id).toBe(first);
    });

    it("deletes entries received before the cutoff", async () => {
      await eventRepo.insertReceived(testDb.db, buildPayload("card.created"), "hash-1");
      await eventRepo.insertReceived(testDb.db, buildPayload("card.deleted"), "hash-2");

      const future = new Date(Date.now() + 60_000);
      expect(await eventRepo.deleteReceivedBefore(testDb.db, future)).toBe(2);
      expect(await testDb.db.query.eventLog.findMany()).toHaveLength(0);

      const past = new Date(Date.now() - 60_000);
      await eventRepo.insertReceived(testDb.db, buildPayload("card.moved"), "hash-3");
      expect(await eventRepo.deleteReceivedBefore(testDb.db, past)).toBe(0);
    });
  });
});
