export interface SerialQueue {
  push: (task: () => Promise<void>) => void;
  /** Resolves once every task pushed so far has settled. */
  onIdle: () => Promise<void>;
}

/**
 * Minimal in-process FIFO queue. Webhook events are processed one at a
 * time in arrival order, so notification order matches event order and
 * Telegram flood limits are not hit by parallel sends.
 */
export function createSerialQueue(
  onError: (error: unknown) => void,
): SerialQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    push: (task) => {
      tail = tail.then(task).catch(onError);
    },
    onIdle: () => tail,
  };
}
