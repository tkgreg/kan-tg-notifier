import { describe, expect, it } from "vitest";

import { createSerialQueue } from "./queue.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createSerialQueue", () => {
  it("runs tasks strictly in order", async () => {
    const order: number[] = [];
    const queue = createSerialQueue(() => undefined);
    const first = deferred();

    queue.push(async () => {
      await first.promise;
      order.push(1);
    });
    queue.push(async () => {
      order.push(2);
    });

    expect(order).toEqual([]);
    first.resolve();
    await queue.onIdle();
    expect(order).toEqual([1, 2]);
  });

  it("keeps processing after a task fails and reports the error", async () => {
    const errors: unknown[] = [];
    const order: number[] = [];
    const queue = createSerialQueue((error) => errors.push(error));

    queue.push(() => Promise.reject(new Error("boom")));
    queue.push(async () => {
      order.push(2);
    });

    await queue.onIdle();
    expect(order).toEqual([2]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });
});
