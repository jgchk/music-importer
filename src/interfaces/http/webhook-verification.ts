import { createHmac, timingSafeEqual } from 'node:crypto';
import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';

/**
 * Standard Webhooks-style delivery verification for the inbound acquisition receiver (design D2)
 * — the mirror of music-downloader's outbound signing: `v1,` + base64 HMAC-SHA256 over
 * `id.timestamp.body` with the shared `whsec_<base64>` secret, plus a replay window on
 * `webhook-timestamp`. Unsigned or stale deliveries are rejected as values before any payload
 * parsing happens.
 */

/** How far a delivery's timestamp may drift from now, in either direction (replay window). */
export const DEFAULT_TOLERANCE_SECONDS = 300;

const SECRET_PREFIX = 'whsec_';

/** Decode the shared signing secret (`whsec_<base64>`; the bare base64 is tolerated). */
export function signingKeyOf(secret: string): Buffer {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  return Buffer.from(encoded, 'base64');
}

/** The three Standard Webhooks headers, as the HTTP layer hands them over (any may be absent). */
export interface WebhookDeliveryHeaders {
  readonly id: string | undefined; // webhook-id
  readonly timestamp: string | undefined; // webhook-timestamp (unix seconds)
  readonly signature: string | undefined; // webhook-signature (space-delimited `scheme,base64` list)
}

export type WebhookVerificationError = 'MissingHeader' | 'StaleTimestamp' | 'InvalidSignature';

export function verifyWebhookDelivery(args: {
  readonly key: Buffer;
  readonly headers: WebhookDeliveryHeaders;
  readonly body: string; // the raw request body — signed byte-for-byte
  readonly now: Date;
  readonly toleranceSeconds?: number;
}): Result<{ readonly deliveryId: string }, WebhookVerificationError> {
  const { id, timestamp, signature } = args.headers;
  if (id === undefined || timestamp === undefined || signature === undefined) {
    return err('MissingHeader');
  }

  const sentAt = Number(timestamp);
  const tolerance = args.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const skew = Math.abs(args.now.getTime() / 1000 - sentAt);
  // A non-numeric timestamp yields NaN, and NaN comparisons are false — rejected as stale.
  if (!(skew <= tolerance)) return err('StaleTimestamp');

  const expected = createHmac('sha256', args.key)
    .update(`${id}.${timestamp}.${args.body}`)
    .digest();
  // The header may carry several signatures (e.g. across a secret rotation); any v1 match passes.
  for (const entry of signature.split(' ')) {
    const separator = entry.indexOf(',');
    if (separator === -1 || entry.slice(0, separator) !== 'v1') continue;
    const given = Buffer.from(entry.slice(separator + 1), 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return ok({ deliveryId: id });
    }
  }
  return err('InvalidSignature');
}
