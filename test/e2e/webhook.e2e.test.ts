import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

/**
 * The signed acquisition receiver, end to end against the real container: a Standard Webhooks
 * delivery (signed exactly as music-downloader's dispatcher signs) submits the re-rooted import
 * through the real event store, a redelivery converges on the durable acquisition linkage, and a
 * bad signature is refused at the edge. The secret and source root mirror test/e2e/run.sh.
 */

const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3900';
const KEY = Buffer.from('e2e-intake-signing-key');
const RECEIVER = `${BASE_URL}/api/v1/webhooks/acquisitions`;

const FULFILLED = JSON.stringify({
  type: 'acquisition.fulfilled',
  timestamp: new Date().toISOString(),
  data: {
    acquisitionId: 'e2e-acq-0001',
    target: {
      type: 'album',
      artist: 'Unknown Homie xq77',
      title: 'Webhook Tape zz94',
      musicbrainzReleaseId: null,
      year: null,
      trackCount: 2,
    },
    candidate: { username: 'peer1', path: 'peer1/webhook-drop', sizeBytes: 1000 },
    location: '/downloads/import/webhook-drop',
    files: [
      { name: '01 Wire One.mp3', path: '/downloads/import/webhook-drop/01 Wire One.mp3' },
      { name: '02 Wire Two.mp3', path: '/downloads/import/webhook-drop/02 Wire Two.mp3' },
    ],
  },
});

function deliver(body: string, key: Buffer = KEY, id = 'e2e-msg-1'): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return fetch(RECEIVER, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    },
    body,
  });
}

async function importsAt(path: string): Promise<{ importId: string; status: string }[]> {
  const res = await fetch(`${BASE_URL}/api/v1/imports`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    imports: { importId: string; path?: string; status: string }[];
  };
  return body.imports.filter((entry) => entry.path === path);
}

describe('the signed acquisition receiver', () => {
  it('refuses a delivery signed with the wrong key', async () => {
    const res = await deliver(FULFILLED, Buffer.from('not-the-shared-key'));
    expect(res.status).toBe(401);
    expect(await importsAt('/music/intake/webhook-drop')).toHaveLength(0);
  });

  it('submits the re-rooted import for a correctly signed delivery, and converges a redelivery', async () => {
    const first = await deliver(FULFILLED);
    expect(first.status).toBe(204);

    const submitted = await importsAt('/music/intake/webhook-drop');
    expect(submitted).toHaveLength(1);

    // The sender is at-least-once: the same event delivered again must not create a second import.
    const again = await deliver(FULFILLED, KEY, 'e2e-msg-2');
    expect(again.status).toBe(204);
    expect(await importsAt('/music/intake/webhook-drop')).toHaveLength(1);
  });

  it('acknowledges and ignores an event type the importer does not consume', async () => {
    const body = JSON.stringify({
      type: 'acquisition.abandoned',
      timestamp: new Date().toISOString(),
      data: { acquisitionId: 'e2e-acq-9999' },
    });
    const res = await deliver(body, KEY, 'e2e-msg-3');
    expect(res.status).toBe(204);
  });
});
