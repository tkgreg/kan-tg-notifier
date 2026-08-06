import { describe, expect, it } from "vitest";

import { buildPayload, TEST_KAN_BASE_URL } from "../test-utils/fixtures.js";
import {
  chunkLines,
  escapeHtml,
  formatCardBatchMessage,
  formatChanges,
  formatMemberDirectMessage,
  maskEmail,
  netMemberChanges,
  truncate,
} from "./format.js";

describe("escapeHtml", () => {
  it("escapes &, < and >", () => {
    expect(escapeHtml('<b>&"</b>')).toBe('&lt;b&gt;&amp;"&lt;/b&gt;');
  });
});

describe("truncate", () => {
  it("keeps short text unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("shortens long text with an ellipsis within the limit", () => {
    const result = truncate("a".repeat(20), 10);
    expect(result).toHaveLength(10);
    expect(result.endsWith("…")).toBe(true);
  });

  it("never splits a surrogate pair", () => {
    // "🎉" is two UTF-16 code units; cutting at 4 would land mid-pair.
    const result = truncate("ab🎉🎉", 4);
    expect(result).toBe("ab…");
    expect(result.includes("�")).toBe(false);
    // The kept string must remain well-formed UTF-16.
    expect(() => new TextEncoder().encode(result)).not.toThrow();
    expect(new TextDecoder().decode(new TextEncoder().encode(result))).toBe(
      result,
    );
  });
});

describe("maskEmail", () => {
  it("keeps the first character and the domain", () => {
    expect(maskEmail("bob@corp.com")).toBe("b***@corp.com");
  });

  it("falls back for strings without a maskable local part", () => {
    expect(maskEmail("@corp.com")).toBe("a member");
    expect(maskEmail("not-an-email")).toBe("a member");
  });
});

describe("chunkLines", () => {
  it("returns one chunk when everything fits", () => {
    expect(chunkLines(["a", "b"], 10)).toEqual(["a\nb"]);
  });

  it("starts a new chunk instead of exceeding the limit", () => {
    const chunks = chunkLines(["aaaa", "bbbb", "cc"], 9);
    expect(chunks).toEqual(["aaaa\nbbbb", "cc"]);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(9);
    }
  });

  it("returns an empty list for no lines", () => {
    expect(chunkLines([], 10)).toEqual([]);
  });
});

describe("formatChanges", () => {
  it("skips the listId change (covered by the Column line)", () => {
    const lines = formatChanges({
      listId: { from: "list-a", to: "list-b" },
    });
    expect(lines).toHaveLength(0);
  });
});

describe("formatCardBatchMessage (single event)", () => {
  it("renders the card-state layout for card.created", () => {
    const text = formatCardBatchMessage(
      [buildPayload("card.created")],
      TEST_KAN_BASE_URL,
    );
    expect(text).toContain(
      `🆕 <b>Card title:</b> <a href="${TEST_KAN_BASE_URL}/cards/card12345678">Fix the flux capacitor</a>`,
    );
    expect(text).toContain("<b>Board:</b> Engineering");
    expect(text).toContain("<b>Column:</b> In Progress");
    expect(text).toContain("<b>Updated at:</b> 2026-08-02 10:00 UTC");
    expect(text).toContain("<b>By:</b> Alice");
    expect(text).toContain("<b>Actions:</b> Created");
  });

  it("escapes HTML in card titles", () => {
    const payload = buildPayload("card.created", {
      card: {
        id: "42",
        publicId: "card12345678",
        title: "<script>alert(1)</script>",
        description: null,
        dueDate: null,
        listId: "list12345678",
        boardId: "board1234567",
      },
    });
    const text = formatCardBatchMessage([payload], TEST_KAN_BASE_URL);
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  it("falls back to 'Someone' when the actor is missing", () => {
    const payload = buildPayload("card.deleted");
    delete payload.data.user;
    const text = formatCardBatchMessage([payload], TEST_KAN_BASE_URL);
    expect(text).toContain("<b>By:</b> Someone");
  });

  it("renders comment text as a blockquote", () => {
    const payload = buildPayload("card.comment.created", {
      comment: { id: "cmnt12345678", text: "Looks good <b>to me</b>" },
    });
    const text = formatCardBatchMessage([payload], TEST_KAN_BASE_URL);
    expect(text).toContain("<b>Actions:</b> Commented");
    expect(text).toContain("💬");
    expect(text).toContain(
      "<blockquote>Looks good &lt;b&gt;to me&lt;/b&gt;</blockquote>",
    );
  });

  it("renders label events on the Labels line", () => {
    const payload = buildPayload("card.label.added", {
      label: { id: "labl12345678", name: "Urgent", colourCode: "#ff0000" },
    });
    const text = formatCardBatchMessage([payload], TEST_KAN_BASE_URL);
    expect(text).toContain("<b>Labels:</b> <b>Urgent</b>");
    expect(text).toContain("<b>Actions:</b> Label added");
  });

  it("renders member events on the Members line", () => {
    const payload = buildPayload("card.member.removed", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const text = formatCardBatchMessage([payload], TEST_KAN_BASE_URL);
    expect(text).toContain("<b>Members:</b> Bob (removed)");
    expect(text).toContain("<b>Actions:</b> Unassigned");
  });

  it("masks the email of members without a display name", () => {
    const payload = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: null, email: "bob@corp.com" },
    });
    const text = formatCardBatchMessage([payload], TEST_KAN_BASE_URL);
    expect(text).not.toContain("bob@corp.com");
    expect(text).toContain("b***@corp.com");
  });

  it("mentions the linked member by @username instead of the OIDC name", () => {
    const payload = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const text = formatCardBatchMessage([payload], TEST_KAN_BASE_URL, {
      memberMentionFor: () => ({
        telegramUserId: 555,
        telegramUsername: "bob_tg",
      }),
    });
    expect(text).toContain("<b>Members:</b> @bob_tg");
    expect(text).not.toContain("<b>Members:</b> Bob");
  });

  it("falls back to a tg://user text mention when the member has no username", () => {
    const payload = buildPayload("card.member.removed", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const text = formatCardBatchMessage([payload], TEST_KAN_BASE_URL, {
      memberMentionFor: () => ({
        telegramUserId: 555,
        telegramUsername: null,
      }),
    });
    expect(text).toContain('<a href="tg://user?id=555">Bob</a>');
  });

  it("marks a moved card with the target column", () => {
    const text = formatCardBatchMessage(
      [buildPayload("card.moved")],
      TEST_KAN_BASE_URL,
    );
    expect(text).toContain("📦");
    expect(text).toContain("<b>Column:</b> In Progress");
    expect(text).toContain("<b>Actions:</b> Moved");
  });

  it("renders change lines for card.updated", () => {
    const payload = buildPayload("card.updated", {
      changes: {
        title: { from: "Old title", to: "New title" },
        description: { from: "a", to: "b" },
        dueDate: { from: null, to: "2026-08-10T00:00:00.000Z" },
      },
    });
    const text = formatCardBatchMessage([payload], TEST_KAN_BASE_URL);
    expect(text).toContain("<b>Actions:</b> Updated");
    expect(text).toContain("• Title: Old title → New title");
    expect(text).toContain("• Description updated");
    expect(text).toContain("• Due date: none → 2026-08-10");
  });

  it("shows a deleted card's title without a link", () => {
    const text = formatCardBatchMessage(
      [buildPayload("card.deleted")],
      TEST_KAN_BASE_URL,
    );
    expect(text).toContain(
      "🗑 <b>Card title:</b> <b>Fix the flux capacitor</b>",
    );
    expect(text).not.toContain("<a href");
    expect(text).toContain("<b>Actions:</b> Deleted");
  });
});

describe("formatCardBatchMessage (multi-event batch)", () => {
  it("merges created + member.added into one card-state message", () => {
    const created = buildPayload("card.created");
    const assigned = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });

    const text = formatCardBatchMessage([created, assigned], TEST_KAN_BASE_URL);

    expect(text?.split("\n")[0]).toContain("🆕");
    expect(text).toContain("<b>Members:</b> Bob");
    expect(text).toContain("<b>Actions:</b> Created, Assigned");
  });

  it("mentions the linked member through memberMentionFor", () => {
    const created = buildPayload("card.created");
    const assigned = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });

    const text = formatCardBatchMessage(
      [created, assigned],
      TEST_KAN_BASE_URL,
      {
        memberMentionFor: () => ({
          telegramUserId: 555,
          telegramUsername: "bobtg",
        }),
      },
    );

    expect(text).toContain("<b>Members:</b> @bobtg");
  });

  it("uses the latest title for the card link", () => {
    const created = buildPayload("card.created");
    const updated = buildPayload("card.updated", {
      changes: { title: { from: "Fix the flux capacitor", to: "New title" } },
    });
    updated.data.card = { ...updated.data.card, title: "New title" };

    const text = formatCardBatchMessage([created, updated], TEST_KAN_BASE_URL);

    expect(text).toContain(">New title</a>");
    expect(text).toContain("<b>Actions:</b> Created, Updated");
  });

  it("omits a member who was added and removed within the batch", () => {
    const member = { id: "membr1234567", name: "Bob", email: "bob@corp.com" };
    const created = buildPayload("card.created");
    const added = buildPayload("card.member.added", { member });
    const removed = buildPayload("card.member.removed", { member });

    const text = formatCardBatchMessage(
      [created, added, removed],
      TEST_KAN_BASE_URL,
    );

    expect(text).toContain("<b>Actions:</b> Created");
    expect(text).not.toContain("Bob");
    expect(text).not.toContain("Members:");
  });

  it("omits a label that was added and removed within the batch", () => {
    const label = { id: "label1234567", name: "Bug", colourCode: "#f00" };
    const added = buildPayload("card.label.added", { label });
    const removed = buildPayload("card.label.removed", { label });
    const comment = buildPayload("card.comment.created", {
      comment: { id: "comnt1234567", text: "still here" },
    });

    const text = formatCardBatchMessage(
      [added, removed, comment],
      TEST_KAN_BASE_URL,
    );

    expect(text).not.toContain("Bug");
    expect(text).toContain("still here");
    expect(text).toContain("<b>Actions:</b> Commented");
  });

  it("returns undefined when everything cancelled out", () => {
    const label = { id: "label1234567", name: "Bug", colourCode: "#f00" };
    const added = buildPayload("card.label.added", { label });
    const removed = buildPayload("card.label.removed", { label });

    expect(
      formatCardBatchMessage([added, removed], TEST_KAN_BASE_URL),
    ).toBeUndefined();
  });

  it("merges field changes across updates and drops round-trips", () => {
    const first = buildPayload("card.updated", {
      changes: {
        title: { from: "A", to: "B" },
        dueDate: { from: null, to: "2026-09-01T00:00:00.000Z" },
      },
    });
    const second = buildPayload("card.updated", {
      changes: { title: { from: "B", to: "A" } },
    });

    const text = formatCardBatchMessage([first, second], TEST_KAN_BASE_URL);

    expect(text).toContain("<b>Actions:</b> Updated");
    expect(text).not.toContain("Title:");
    expect(text).toContain("Due date: none → 2026-09-01");
  });

  it("lists the deletion alongside earlier actions and drops details", () => {
    const updated = buildPayload("card.updated", {
      changes: { title: { from: "A", to: "B" } },
    });
    const assigned = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const deleted = buildPayload("card.deleted");

    const text = formatCardBatchMessage(
      [updated, assigned, deleted],
      TEST_KAN_BASE_URL,
    );

    expect(text).toContain("🗑");
    expect(text).toContain("<b>Actions:</b> Updated, Assigned, Deleted");
    expect(text).not.toContain("Title:");
    expect(text).not.toContain("<a href");
  });

  it("lists Created and Deleted when the whole lifecycle fits the batch", () => {
    const created = buildPayload("card.created");
    const deleted = buildPayload("card.deleted");

    const text = formatCardBatchMessage([created, deleted], TEST_KAN_BASE_URL);

    expect(text).toContain("<b>Actions:</b> Created, Deleted");
  });

  it("uses the final column for a card moved twice", () => {
    const firstMove = buildPayload("card.moved", {
      list: { id: "list00000001", name: "Doing" },
    });
    const secondMove = buildPayload("card.moved", {
      list: { id: "list00000002", name: "Done" },
    });

    const text = formatCardBatchMessage(
      [firstMove, secondMove],
      TEST_KAN_BASE_URL,
    );

    expect(text).toContain("<b>Column:</b> Done");
    expect(text).toContain("<b>Actions:</b> Moved");
    expect(text).not.toContain("Doing");
  });

  it("keeps only the latest text of a comment edited after creation", () => {
    const comment = { id: "comnt1234567", text: "first draft" };
    const createdComment = buildPayload("card.comment.created", { comment });
    const editedComment = buildPayload("card.comment.updated", {
      comment: { id: "comnt1234567", text: "final version" },
    });

    const text = formatCardBatchMessage(
      [createdComment, editedComment],
      TEST_KAN_BASE_URL,
    );

    expect(text).toContain("<b>Actions:</b> Commented");
    expect(text).toContain("final version");
    expect(text).not.toContain("first draft");
  });

  it("drops a comment created and deleted within the batch", () => {
    const comment = { id: "comnt1234567", text: "oops" };
    const createdComment = buildPayload("card.comment.created", { comment });
    const deletedComment = buildPayload("card.comment.deleted", { comment });
    const created = buildPayload("card.created");

    const text = formatCardBatchMessage(
      [created, createdComment, deletedComment],
      TEST_KAN_BASE_URL,
    );

    expect(text).not.toContain("oops");
    expect(text).toContain("<b>Actions:</b> Created");
  });

  it("names both actors when different people acted", () => {
    const created = buildPayload("card.created");
    const assigned = buildPayload("card.member.added", {
      user: { id: "user-2", name: "Carol" },
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });

    const text = formatCardBatchMessage([created, assigned], TEST_KAN_BASE_URL);

    expect(text).toContain("<b>By:</b> Alice and Carol");
  });
});

describe("netMemberChanges", () => {
  it("cancels an add+remove pair and keeps the net direction", () => {
    const member = { id: "membr1234567", name: "Bob", email: "bob@corp.com" };
    const added = buildPayload("card.member.added", { member });
    const removed = buildPayload("card.member.removed", { member });
    const other = buildPayload("card.member.added", {
      member: { id: "membr7654321", name: "Dan", email: "dan@corp.com" },
    });

    const changes = netMemberChanges([added, removed, other]);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.net).toBe(1);
    expect(changes[0]?.payload.data.member?.email).toBe("dan@corp.com");
  });
});

describe("formatMemberDirectMessage", () => {
  it("addresses the member directly on assignment", () => {
    const payload = buildPayload("card.member.added", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const text = formatMemberDirectMessage(payload, TEST_KAN_BASE_URL);
    expect(text).toContain("assigned you to");
    expect(text).toContain("<b>Alice</b>");
  });

  it("addresses the member directly on removal", () => {
    const payload = buildPayload("card.member.removed", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const text = formatMemberDirectMessage(payload, TEST_KAN_BASE_URL);
    expect(text).toContain("removed you from");
  });
});
