import { describe, expect, it } from "vitest";

import type { CardThread } from "./threads.js";
import { createThreadRegistry } from "./threads.js";

function thread(): CardThread {
  return { events: [], messages: new Map() };
}

describe("createThreadRegistry", () => {
  it("returns a stored thread within the ttl", () => {
    let nowMs = 0;
    const registry = createThreadRegistry(10_000, () => nowMs);
    const stored = thread();

    registry.set("card1", stored);
    nowMs = 9_999;
    expect(registry.get("card1")).toBe(stored);
  });

  it("drops a thread after the ttl", () => {
    let nowMs = 0;
    const registry = createThreadRegistry(10_000, () => nowMs);

    registry.set("card1", thread());
    nowMs = 10_001;
    expect(registry.get("card1")).toBeUndefined();
  });

  it("re-arms the ttl on every write", () => {
    let nowMs = 0;
    const registry = createThreadRegistry(10_000, () => nowMs);

    registry.set("card1", thread());
    nowMs = 8_000;
    registry.set("card1", thread());
    nowMs = 15_000;
    expect(registry.get("card1")).toBeDefined();
  });

  it("remembers nothing when the ttl is zero", () => {
    const registry = createThreadRegistry(0);
    registry.set("card1", thread());
    expect(registry.get("card1")).toBeUndefined();
  });
});
