import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  computeSignature,
  isTimestampFresh,
  verifySignature,
} from "./signature.js";

const SECRET = "test-secret-at-least-16-chars";

// Replicates generateSignature in kan's packages/api/src/utils/webhook.ts.
function kanSideSignature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("computeSignature", () => {
  it("matches the signature kan generates for the same body and secret", () => {
    const body = JSON.stringify({ event: "card.created", data: {} });
    expect(computeSignature(Buffer.from(body), SECRET)).toBe(
      kanSideSignature(body, SECRET),
    );
  });
});

describe("verifySignature", () => {
  const body = Buffer.from(JSON.stringify({ event: "card.created" }));

  it("accepts a valid signature", () => {
    const signature = computeSignature(body, SECRET);
    expect(verifySignature(body, signature, SECRET)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const signature = computeSignature(body, "another-secret-16-chars");
    expect(verifySignature(body, signature, SECRET)).toBe(false);
  });

  it("rejects a signature over a different body", () => {
    const signature = computeSignature(Buffer.from("other"), SECRET);
    expect(verifySignature(body, signature, SECRET)).toBe(false);
  });

  it("rejects a malformed (non-hex, odd-length) header", () => {
    expect(verifySignature(body, "zzzz", SECRET)).toBe(false);
    expect(verifySignature(body, "abc", SECRET)).toBe(false);
    expect(verifySignature(body, "", SECRET)).toBe(false);
  });

  it("rejects a truncated valid signature", () => {
    const signature = computeSignature(body, SECRET);
    expect(verifySignature(body, signature.slice(0, 32), SECRET)).toBe(false);
  });
});

describe("isTimestampFresh", () => {
  const now = new Date("2026-08-02T10:00:00.000Z");

  it("accepts a timestamp within the tolerance", () => {
    expect(isTimestampFresh("2026-08-02T09:55:00.000Z", 600, now)).toBe(true);
  });

  it("accepts a slightly future timestamp (clock skew)", () => {
    expect(isTimestampFresh("2026-08-02T10:03:00.000Z", 600, now)).toBe(true);
  });

  it("rejects a timestamp older than the tolerance", () => {
    expect(isTimestampFresh("2026-08-02T09:45:00.000Z", 600, now)).toBe(false);
  });

  it("rejects an unparseable timestamp", () => {
    expect(isTimestampFresh("not-a-date", 600, now)).toBe(false);
  });

  it("accepts anything when the tolerance is 0 (disabled)", () => {
    expect(isTimestampFresh("2020-01-01T00:00:00.000Z", 0, now)).toBe(true);
  });
});
