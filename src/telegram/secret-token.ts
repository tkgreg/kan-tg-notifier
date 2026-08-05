import { timingSafeEqual } from "node:crypto";

/**
 * Verify the X-Telegram-Bot-Api-Secret-Token header Telegram echoes back on
 * every webhook delivery. This is the only thing that authenticates the
 * update route, so the comparison is constant-time. A missing header is a
 * plain false instead of a throw, so callers keep a single 401 path.
 */
export function verifySecretToken(
  received: string | undefined,
  expected: string,
): boolean {
  if (received === undefined) return false;

  const receivedBytes = Buffer.from(received, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (receivedBytes.length !== expectedBytes.length) return false;

  return timingSafeEqual(receivedBytes, expectedBytes);
}
