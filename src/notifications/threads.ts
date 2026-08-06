import type { StoredEvent } from "./processor.js";

export interface CardThreadMessage {
  messageId: number;
  /** Last rendered text, to skip no-op edits. */
  text: string;
}

/**
 * Everything already delivered about one card: the events rendered so far
 * and the group message posted per chat. Follow-up events re-render the
 * accumulated state and edit those messages instead of posting again.
 */
export interface CardThread {
  events: StoredEvent[];
  /** Group message already posted, keyed by chat id. */
  messages: Map<number, CardThreadMessage>;
}

export interface ThreadRegistry {
  /** The live thread for a card, if its update window has not expired. */
  get: (cardPublicId: string) => CardThread | undefined;
  set: (cardPublicId: string, thread: CardThread) => void;
}

/** Upper bound on remembered cards; the oldest threads are evicted first. */
const MAX_THREADS = 1000;

/**
 * In-memory registry of per-card notification threads. A thread expires
 * ttlMs after it was last written; expired threads are dropped lazily.
 * With ttlMs <= 0 the registry remembers nothing and every batch of
 * events produces new messages.
 */
export function createThreadRegistry(
  ttlMs: number,
  now: () => number = Date.now,
): ThreadRegistry {
  if (ttlMs <= 0) {
    return { get: () => undefined, set: () => undefined };
  }

  const threads = new Map<string, { thread: CardThread; touchedAt: number }>();

  const prune = (): void => {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of threads) {
      if (entry.touchedAt < cutoff) threads.delete(key);
    }
    // Map iteration follows insertion order and set() re-inserts on every
    // write, so the first keys are the least recently touched.
    while (threads.size > MAX_THREADS) {
      const oldest = threads.keys().next().value;
      if (oldest === undefined) break;
      threads.delete(oldest);
    }
  };

  return {
    get: (cardPublicId) => {
      const entry = threads.get(cardPublicId);
      if (!entry) return undefined;
      if (entry.touchedAt < now() - ttlMs) {
        threads.delete(cardPublicId);
        return undefined;
      }
      return entry.thread;
    },
    set: (cardPublicId, thread) => {
      threads.delete(cardPublicId);
      threads.set(cardPublicId, { thread, touchedAt: now() });
      prune();
    },
  };
}
