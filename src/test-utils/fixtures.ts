import type { KanWebhookEvent, KanWebhookPayload } from "../kan/events.js";
import type { ChatSubscription, UserMapping } from "../db/schema.js";

export const TEST_KAN_BASE_URL = "https://kan.example.com";

export function buildPayload(
  event: KanWebhookEvent,
  overrides: Partial<KanWebhookPayload["data"]> = {},
): KanWebhookPayload {
  return {
    event,
    timestamp: "2026-08-02T10:00:00.000Z",
    data: {
      card: {
        id: "42",
        publicId: "card12345678",
        title: "Fix the flux capacitor",
        description: null,
        dueDate: null,
        listId: "list12345678",
        boardId: "board1234567",
      },
      board: { id: "board1234567", name: "Engineering" },
      list: { id: "list12345678", name: "In Progress" },
      user: { id: "b3b5ee12-0a70-4b52-a583-3f52802cd825", name: "Alice" },
      ...overrides,
    },
  };
}

export function buildSubscription(
  overrides: Partial<ChatSubscription> = {},
): ChatSubscription {
  return {
    id: 1,
    chatId: -1001234567890,
    chatType: "supergroup",
    chatTitle: "Team chat",
    allEvents: true,
    events: [],
    boardPublicIds: [],
    createdBy: 111,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: null,
    ...overrides,
  };
}

export function buildMapping(
  overrides: Partial<UserMapping> = {},
): UserMapping {
  return {
    id: 1,
    telegramUserId: 555,
    telegramUsername: "bob",
    kanEmail: "bob@corp.com",
    status: "approved",
    requestedAt: new Date("2026-08-01T00:00:00Z"),
    approvedAt: new Date("2026-08-01T01:00:00Z"),
    approvedBy: 111,
    ...overrides,
  };
}
