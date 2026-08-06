import type { StoredEvent } from "./processor.js";

export interface CardAggregator {
  push: (event: StoredEvent) => void;
  /** Flush every pending batch immediately, e.g. on shutdown. */
  flushAll: () => void;
}

/**
 * Collects webhook events per card for a fixed window after the first one
 * arrives, then hands the whole batch to onFlush. Kan emits one webhook
 * per elementary action ("created", "member added", …), so a single user
 * gesture like creating a card with an assignee produces several
 * deliveries within moments of each other; batching them lets the
 * notification layer describe the card's resulting state in one message
 * instead of one message per delivery.
 *
 * The window is fixed, not sliding: later events join the open batch but
 * never extend it, so notification latency is bounded by windowMs.
 */
export function createCardAggregator(
  windowMs: number,
  onFlush: (events: StoredEvent[]) => void,
): CardAggregator {
  if (windowMs <= 0) {
    return {
      push: (event) => onFlush([event]),
      flushAll: () => undefined,
    };
  }

  const pending = new Map<
    string,
    { events: StoredEvent[]; timer: NodeJS.Timeout }
  >();

  const flush = (cardPublicId: string): void => {
    const batch = pending.get(cardPublicId);
    if (!batch) return;
    pending.delete(cardPublicId);
    clearTimeout(batch.timer);
    onFlush(batch.events);
  };

  return {
    push: (event) => {
      const cardPublicId = event.payload.data.card.publicId;
      const batch = pending.get(cardPublicId);
      if (batch) {
        batch.events.push(event);
        return;
      }
      const timer = setTimeout(() => flush(cardPublicId), windowMs);
      // The timer must not keep the process alive on its own; shutdown
      // flushes explicitly via flushAll().
      timer.unref();
      pending.set(cardPublicId, { events: [event], timer });
    },
    flushAll: () => {
      for (const cardPublicId of [...pending.keys()]) {
        flush(cardPublicId);
      }
    },
  };
}
