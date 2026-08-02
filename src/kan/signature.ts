import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compute the signature Kan.bn puts in the X-Webhook-Signature header:
 * hex-encoded HMAC-SHA256 of the raw request body.
 */
export function computeSignature(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Verify a webhook signature using a constant-time comparison.
 * Returns false for a missing or malformed header instead of throwing,
 * so callers can turn it into a single 401 path.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;

  const expected = Buffer.from(computeSignature(rawBody, secret), "hex");
  let received: Buffer;
  try {
    received = Buffer.from(signatureHeader, "hex");
  } catch {
    return false;
  }

  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}

/**
 * Check that the signed payload timestamp is within the allowed clock
 * tolerance (replay protection). A tolerance of 0 disables the check.
 */
export function isTimestampFresh(
  timestampIso: string,
  toleranceSeconds: number,
  now: Date,
): boolean {
  if (toleranceSeconds === 0) return true;

  const timestampMs = Date.parse(timestampIso);
  if (Number.isNaN(timestampMs)) return false;

  const skewMs = Math.abs(now.getTime() - timestampMs);
  return skewMs <= toleranceSeconds * 1000;
}
