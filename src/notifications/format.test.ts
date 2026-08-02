import { describe, expect, it } from "vitest";

import {
  buildPayload,
  TEST_KAN_BASE_URL,
} from "../test-utils/fixtures.js";
import {
  escapeHtml,
  formatChanges,
  formatEventMessage,
  formatMemberDirectMessage,
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
});

describe("formatEventMessage", () => {
  it("renders card.created with actor, link and context", () => {
    const text = formatEventMessage(buildPayload("card.created"), TEST_KAN_BASE_URL);
    expect(text).toContain("<b>Alice</b>");
    expect(text).toContain(
      `<a href="${TEST_KAN_BASE_URL}/cards/card12345678">Fix the flux capacitor</a>`,
    );
    expect(text).toContain("Engineering · In Progress");
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
    const text = formatEventMessage(payload, TEST_KAN_BASE_URL);
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  it("falls back to 'Someone' when the actor is missing", () => {
    const payload = buildPayload("card.deleted");
    delete payload.data.user;
    const text = formatEventMessage(payload, TEST_KAN_BASE_URL);
    expect(text).toContain("<b>Someone</b>");
  });

  it("renders comment text as a blockquote", () => {
    const payload = buildPayload("card.comment.created", {
      comment: { id: "cmnt12345678", text: "Looks good <b>to me</b>" },
    });
    const text = formatEventMessage(payload, TEST_KAN_BASE_URL);
    expect(text).toContain("<blockquote>Looks good &lt;b&gt;to me&lt;/b&gt;</blockquote>");
  });

  it("renders label events with the label name", () => {
    const payload = buildPayload("card.label.added", {
      label: { id: "labl12345678", name: "Urgent", colourCode: "#ff0000" },
    });
    const text = formatEventMessage(payload, TEST_KAN_BASE_URL);
    expect(text).toContain("added label <b>Urgent</b>");
  });

  it("renders member events with the member name", () => {
    const payload = buildPayload("card.member.removed", {
      member: { id: "membr1234567", name: "Bob", email: "bob@corp.com" },
    });
    const text = formatEventMessage(payload, TEST_KAN_BASE_URL);
    expect(text).toContain("removed Bob from");
  });

  it("renders card.moved with the target list", () => {
    const text = formatEventMessage(buildPayload("card.moved"), TEST_KAN_BASE_URL);
    expect(text).toContain("moved");
    expect(text).toContain("to <i>In Progress</i>");
  });

  it("renders change lines for card.updated", () => {
    const payload = buildPayload("card.updated", {
      changes: {
        title: { from: "Old title", to: "New title" },
        description: { from: "a", to: "b" },
        dueDate: { from: null, to: "2026-08-10T00:00:00.000Z" },
      },
    });
    const text = formatEventMessage(payload, TEST_KAN_BASE_URL);
    expect(text).toContain("• Title: Old title → New title");
    expect(text).toContain("• Description updated");
    expect(text).toContain("• Due date: none → 2026-08-10");
  });
});

describe("formatChanges", () => {
  it("skips the listId change (covered by the card.moved header)", () => {
    const lines = formatChanges({
      listId: { from: "list-a", to: "list-b" },
    });
    expect(lines).toHaveLength(0);
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
