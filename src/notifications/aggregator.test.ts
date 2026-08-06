import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredEvent } from "./processor.js";
import { buildPayload } from "../test-utils/fixtures.js";
import { createCardAggregator } from "./aggregator.js";

const WINDOW_MS = 15_000;

function storedEvent(
  id: number,
  event: Parameters<typeof buildPayload>[0],
  cardPublicId = "card12345678",
): StoredEvent {
  const payload = buildPayload(event);
  payload.data.card.publicId = cardPublicId;
  return { id, payload };
}

describe("createCardAggregator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collects events for the same card into one batch", () => {
    const batches: StoredEvent[][] = [];
    const aggregator = createCardAggregator(WINDOW_MS, (events) =>
      batches.push(events),
    );

    aggregator.push(storedEvent(1, "card.created"));
    vi.advanceTimersByTime(5_000);
    aggregator.push(storedEvent(2, "card.member.added"));

    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(WINDOW_MS);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((event) => event.id)).toEqual([1, 2]);
  });

  it("does not extend the window when later events arrive", () => {
    const batches: StoredEvent[][] = [];
    const aggregator = createCardAggregator(WINDOW_MS, (events) =>
      batches.push(events),
    );

    aggregator.push(storedEvent(1, "card.created"));
    vi.advanceTimersByTime(WINDOW_MS - 1);
    aggregator.push(storedEvent(2, "card.member.added"));
    vi.advanceTimersByTime(1);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((event) => event.id)).toEqual([1, 2]);
  });

  it("keeps different cards in separate batches", () => {
    const batches: StoredEvent[][] = [];
    const aggregator = createCardAggregator(WINDOW_MS, (events) =>
      batches.push(events),
    );

    aggregator.push(storedEvent(1, "card.created", "cardaaaaaaaa"));
    aggregator.push(storedEvent(2, "card.created", "cardbbbbbbbb"));
    vi.advanceTimersByTime(WINDOW_MS);

    expect(batches).toHaveLength(2);
    expect(batches[0]?.map((event) => event.id)).toEqual([1]);
    expect(batches[1]?.map((event) => event.id)).toEqual([2]);
  });

  it("starts a new batch after a flush", () => {
    const batches: StoredEvent[][] = [];
    const aggregator = createCardAggregator(WINDOW_MS, (events) =>
      batches.push(events),
    );

    aggregator.push(storedEvent(1, "card.created"));
    vi.advanceTimersByTime(WINDOW_MS);
    aggregator.push(storedEvent(2, "card.updated"));
    vi.advanceTimersByTime(WINDOW_MS);

    expect(batches.map((batch) => batch.map((event) => event.id))).toEqual([
      [1],
      [2],
    ]);
  });

  it("flushAll delivers pending batches immediately", () => {
    const batches: StoredEvent[][] = [];
    const aggregator = createCardAggregator(WINDOW_MS, (events) =>
      batches.push(events),
    );

    aggregator.push(storedEvent(1, "card.created", "cardaaaaaaaa"));
    aggregator.push(storedEvent(2, "card.created", "cardbbbbbbbb"));
    aggregator.flushAll();

    expect(batches).toHaveLength(2);
    // The timers were cleared: nothing fires again later.
    vi.advanceTimersByTime(WINDOW_MS * 2);
    expect(batches).toHaveLength(2);
  });

  it("flushes every event immediately when the window is zero", () => {
    const batches: StoredEvent[][] = [];
    const aggregator = createCardAggregator(0, (events) =>
      batches.push(events),
    );

    aggregator.push(storedEvent(1, "card.created"));
    aggregator.push(storedEvent(2, "card.member.added"));

    expect(batches.map((batch) => batch.map((event) => event.id))).toEqual([
      [1],
      [2],
    ]);
  });
});
