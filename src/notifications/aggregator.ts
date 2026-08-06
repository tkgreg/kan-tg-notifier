import type { StoredEvent } from "./processor.js";

export interface CardAggregator {
  push: (event: StoredEvent) => void;
  /** Flush every pending batch immediately, e.g. on shutdown. */
  flushAll: () => void;
}

/**
 * Debounces webhook events per card: the batch is flushed once the card
 * has been quiet for windowMs — every new event for the card merges into
 * the open batch and restarts the wait. Kan emits one webhook per
 * elementary action ("created", "member added", …), so a user gesture
 * like creating a card and then assigning a member produces several
 * deliveries; the sliding window keeps collecting until the activity
 * stops and the notification layer then describes the card's resulting
 * state in a single message.
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

  // The timers must not keep the process alive on their own; shutdown
  // flushes explicitly via flushAll().
  const armTimer = (cardPublicId: string): NodeJS.Timeout => {
    const timer = setTimeout(() => flush(cardPublicId), windowMs);
    timer.unref();
    return timer;
  };

  return {
    push: (event) => {
      const cardPublicId = event.payload.data.card.publicId;
      const batch = pending.get(cardPublicId);
      if (batch) {
        batch.events.push(event);
        clearTimeout(batch.timer);
        batch.timer = armTimer(cardPublicId);
        return;
      }
      pending.set(cardPublicId, {
        events: [event],
        timer: armTimer(cardPublicId),
      });
    },
    flushAll: () => {
      for (const cardPublicId of [...pending.keys()]) {
        flush(cardPublicId);
      }
    },
  };
}
