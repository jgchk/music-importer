import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE_SECONDS,
  signingKeyOf,
  verifyWebhookDelivery,
} from './webhook-verification.js';

const KEY_BYTES = Buffer.from('receiver-signing-key-0123456789ab');
const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
const NOW = new Date('2026-07-19T12:00:00.000Z');
const BODY = '{"data":{"acquisitionId":"acq-1"}}';

function sign(id: string, timestamp: string, body: string, key: Buffer = KEY_BYTES): string {
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

function timestampAt(offsetSeconds = 0): string {
  return String(Math.floor(NOW.getTime() / 1000) + offsetSeconds);
}

function headersFor(overrides: Partial<Record<'id' | 'timestamp' | 'signature', string>> = {}) {
  const timestamp = overrides.timestamp ?? timestampAt();
  const id = overrides.id ?? 'msg-1';
  return {
    id,
    timestamp,
    signature: overrides.signature ?? sign(id, timestamp, BODY),
  };
}

describe('signingKeyOf', () => {
  it('decodes a whsec_-prefixed secret and tolerates a bare base64 one', () => {
    expect(signingKeyOf(SECRET)).toEqual(KEY_BYTES);
    expect(signingKeyOf(KEY_BYTES.toString('base64'))).toEqual(KEY_BYTES);
  });
});

describe('verifyWebhookDelivery — Standard Webhooks style (D2)', () => {
  const key = signingKeyOf(SECRET);

  it('accepts a correctly signed delivery within the timestamp window', () => {
    const result = verifyWebhookDelivery({ key, headers: headersFor(), body: BODY, now: NOW });
    expect(result._unsafeUnwrap()).toEqual({ deliveryId: 'msg-1' });
  });

  it('accepts when any of several space-delimited signatures matches', () => {
    const timestamp = timestampAt();
    const signature = `v1,bm90LXRoaXM= v2,ignored ${sign('msg-1', timestamp, BODY)}`;
    const result = verifyWebhookDelivery({
      key,
      headers: { id: 'msg-1', timestamp, signature },
      body: BODY,
      now: NOW,
    });
    expect(result.isOk()).toBe(true);
  });

  it('rejects a delivery missing any webhook header', () => {
    for (const missing of ['id', 'timestamp', 'signature'] as const) {
      const headers = { ...headersFor(), [missing]: undefined };
      const result = verifyWebhookDelivery({ key, headers, body: BODY, now: NOW });
      expect(result._unsafeUnwrapErr()).toBe('MissingHeader');
    }
  });

  it('rejects a signature over different bytes or from a different key', () => {
    const tampered = verifyWebhookDelivery({
      key,
      headers: headersFor(),
      body: `${BODY} `,
      now: NOW,
    });
    expect(tampered._unsafeUnwrapErr()).toBe('InvalidSignature');

    const timestamp = timestampAt();
    const foreign = verifyWebhookDelivery({
      key,
      headers: {
        id: 'msg-1',
        timestamp,
        signature: sign('msg-1', timestamp, BODY, Buffer.from('some-other-key')),
      },
      body: BODY,
      now: NOW,
    });
    expect(foreign._unsafeUnwrapErr()).toBe('InvalidSignature');
  });

  it('rejects a signature carrying no v1 candidate at all', () => {
    const result = verifyWebhookDelivery({
      key,
      headers: headersFor({ signature: 'v2,abc malformed' }),
      body: BODY,
      now: NOW,
    });
    expect(result._unsafeUnwrapErr()).toBe('InvalidSignature');
  });

  it('rejects a timestamp outside the replay window, in either direction', () => {
    for (const offset of [-(DEFAULT_TOLERANCE_SECONDS + 1), DEFAULT_TOLERANCE_SECONDS + 1]) {
      const timestamp = timestampAt(offset);
      const result = verifyWebhookDelivery({
        key,
        headers: { id: 'msg-1', timestamp, signature: sign('msg-1', timestamp, BODY) },
        body: BODY,
        now: NOW,
      });
      expect(result._unsafeUnwrapErr()).toBe('StaleTimestamp');
    }
  });

  it('accepts a timestamp exactly at the window edge', () => {
    const timestamp = timestampAt(-DEFAULT_TOLERANCE_SECONDS);
    const result = verifyWebhookDelivery({
      key,
      headers: { id: 'msg-1', timestamp, signature: sign('msg-1', timestamp, BODY) },
      body: BODY,
      now: NOW,
    });
    expect(result.isOk()).toBe(true);
  });

  it('rejects a non-numeric timestamp', () => {
    const result = verifyWebhookDelivery({
      key,
      headers: headersFor({ timestamp: 'yesterday' }),
      body: BODY,
      now: NOW,
    });
    expect(result._unsafeUnwrapErr()).toBe('StaleTimestamp');
  });

  it('honors an explicit tolerance override', () => {
    const timestamp = timestampAt(-30);
    const result = verifyWebhookDelivery({
      key,
      headers: { id: 'msg-1', timestamp, signature: sign('msg-1', timestamp, BODY) },
      body: BODY,
      now: NOW,
      toleranceSeconds: 10,
    });
    expect(result._unsafeUnwrapErr()).toBe('StaleTimestamp');
  });
});
