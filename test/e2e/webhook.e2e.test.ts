import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The signed webhook edges, end to end against the real container(s): a Standard Webhooks
 * acquisition delivery (signed exactly as music-downloader's dispatcher signs) submits the
 * re-rooted import through the real event store, a redelivery converges on the durable acquisition
 * linkage, and a bad signature is refused at the edge. Then the outbound loop: resolving that
 * import with reject-and-retry-download deletes the intake AND delivers a signed `release.verdict`
 * to a stub subscriber running in this process (the HMAC is verified against the shared secret),
 * while a second, verdict-unconfigured container proves dormant means no delivery at all.
 * Secrets, roots, and ports mirror test/e2e/run.sh.
 */

const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3900';
const DORMANT_BASE_URL = process.env['E2E_DORMANT_BASE_URL'] ?? 'http://localhost:3902';
const DATA_DIR = process.env['E2E_DATA_DIR'] ?? join(process.cwd(), '.e2e-tmp');
const VERDICT_PORT = Number(process.env['E2E_VERDICT_PORT'] ?? 3901);

const INTAKE_KEY = Buffer.from('e2e-intake-signing-key');
const VERDICT_KEY = Buffer.from('e2e-verdict-signing-key');

function fulfilledEvent(acquisitionId: string, release: string): string {
  return JSON.stringify({
    type: 'acquisition.fulfilled',
    timestamp: new Date().toISOString(),
    data: {
      acquisitionId,
      target: {
        type: 'album',
        artist: 'Unknown Homie xq77',
        title: 'Webhook Tape zz94',
        musicbrainzReleaseId: null,
        year: null,
        trackCount: 2,
      },
      candidate: { username: 'peer1', path: `peer1/${release}`, sizeBytes: 1000 },
      location: `/downloads/import/${release}`,
      files: [
        { name: '01.mp3', path: `/downloads/import/${release}/01.mp3` },
        { name: '02.mp3', path: `/downloads/import/${release}/02.mp3` },
      ],
    },
  });
}

const FULFILLED = fulfilledEvent('e2e-acq-0001', 'webhook-drop');

function deliver(
  body: string,
  key: Buffer = INTAKE_KEY,
  id = 'e2e-msg-1',
  baseUrl = BASE_URL,
): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return fetch(`${baseUrl}/api/v1/webhooks/acquisitions`, {
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

interface StatusBody {
  importId: string;
  status: string;
  rejection?: { reason: string; filesDeleted: boolean };
}

async function importsAt(
  path: string,
  baseUrl = BASE_URL,
): Promise<{ importId: string; status: string }[]> {
  const res = await fetch(`${baseUrl}/api/v1/imports`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    imports: { importId: string; path?: string; status: string }[];
  };
  return body.imports.filter((entry) => entry.path === path);
}

async function waitForStatus(
  importId: string,
  done: (body: StatusBody) => boolean,
  baseUrl = BASE_URL,
  timeoutMs = 150_000,
): Promise<StatusBody> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${baseUrl}/api/v1/imports/${importId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusBody;
    if (done(body)) return body;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting on ${importId}; last: ${JSON.stringify(body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

// --- The stub verdict subscriber: records every delivery, raw body included ---------------------

interface VerdictDelivery {
  readonly headers: IncomingHttpHeaders;
  readonly rawBody: string;
}

const verdictDeliveries: VerdictDelivery[] = [];
let stub: Server;

beforeAll(async () => {
  stub = createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk: Buffer) => (rawBody += chunk.toString()));
    req.on('end', () => {
      verdictDeliveries.push({ headers: req.headers, rawBody });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => stub.listen(VERDICT_PORT, '0.0.0.0', resolve));
});

afterAll(() => new Promise<void>((resolve) => stub.close(() => resolve())));

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
    const again = await deliver(FULFILLED, INTAKE_KEY, 'e2e-msg-2');
    expect(again.status).toBe(204);
    expect(await importsAt('/music/intake/webhook-drop')).toHaveLength(1);
  });

  it('acknowledges and ignores an event type the importer does not consume', async () => {
    const body = JSON.stringify({
      type: 'acquisition.abandoned',
      timestamp: new Date().toISOString(),
      data: { acquisitionId: 'e2e-acq-9999' },
    });
    const res = await deliver(body, INTAKE_KEY, 'e2e-msg-3');
    expect(res.status).toBe(204);
  });
});

describe('the outbound release.verdict publisher', () => {
  it('reject-and-retry-download deletes the intake and delivers a signed verdict to the subscriber', async () => {
    const [submitted] = await importsAt('/music/intake/webhook-drop');
    expect(submitted).toBeDefined();
    const importId = submitted!.importId;

    // The unmatchable fixture album lands in review (no-match or a weak match-review).
    await waitForStatus(importId, (body) => body.status === 'awaiting-review');

    const res = await fetch(`${BASE_URL}/api/v1/imports/${importId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'reject-and-retry-download', reasons: ['e2e: bad copy'] }),
    });
    expect(res.status).toBe(202);

    // Everything plain reject does: files deleted from intake, import terminal rejected.
    const done = await waitForStatus(importId, (body) => body.status === 'rejected');
    expect(done.rejection).toEqual({ reason: 'e2e: bad copy', filesDeleted: true });
    expect(existsSync(join(DATA_DIR, 'music/intake/webhook-drop'))).toBe(false);

    // ...plus the signed delivery at the stub subscriber.
    const deadline = Date.now() + 60_000;
    let delivery: VerdictDelivery | undefined;
    for (;;) {
      delivery = verdictDeliveries.find((entry) => entry.rawBody.includes('"e2e-acq-0001"'));
      if (delivery !== undefined) break;
      if (Date.now() >= deadline) throw new Error('no verdict delivery arrived at the stub');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    // The envelope and payload the downloader's tolerant reader consumes.
    const body = JSON.parse(delivery.rawBody) as {
      type: string;
      timestamp: string;
      data: unknown;
    };
    expect(body.type).toBe('release.verdict');
    expect(body.data).toEqual({
      acquisitionId: 'e2e-acq-0001',
      candidate: { username: 'peer1', path: 'peer1/webhook-drop', sizeBytes: 1000 },
      verdict: 'rejected',
      reasons: ['e2e: bad copy'],
    });

    // Standard Webhooks headers with a verifiable HMAC over `id.timestamp.rawBody`.
    const id = delivery.headers['webhook-id'] as string;
    const timestamp = delivery.headers['webhook-timestamp'] as string;
    const signature = delivery.headers['webhook-signature'] as string;
    expect(id).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(Math.abs(Number(timestamp) - Date.now() / 1000)).toBeLessThan(300);
    const expected = createHmac('sha256', VERDICT_KEY)
      .update(`${id}.${timestamp}.${delivery.rawBody}`)
      .digest();
    const given = Buffer.from(signature.replace(/^v1,/, ''), 'base64');
    expect(given.length).toBe(expected.length);
    expect(timingSafeEqual(given, expected)).toBe(true);
  });

  it('an unconfigured (dormant) instance records the verdict but delivers nothing', async () => {
    const delivered = await deliver(
      fulfilledEvent('e2e-acq-dormant', 'dormant-drop'),
      INTAKE_KEY,
      'e2e-msg-dormant',
      DORMANT_BASE_URL,
    );
    expect(delivered.status).toBe(204);
    const [submitted] = await importsAt('/music/intake/dormant-drop', DORMANT_BASE_URL);
    const importId = submitted!.importId;
    await waitForStatus(importId, (body) => body.status === 'awaiting-review', DORMANT_BASE_URL);

    const res = await fetch(`${DORMANT_BASE_URL}/api/v1/imports/${importId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'reject-and-retry-download', reasons: ['e2e: dormant'] }),
    });
    expect(res.status).toBe(202); // the verb works — the candidate was retained

    await waitForStatus(importId, (body) => body.status === 'rejected', DORMANT_BASE_URL);
    expect(existsSync(join(DATA_DIR, 'music/intake/dormant-drop'))).toBe(false);

    // Dormant means dormant: give a would-be publisher ample time, then assert silence.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(
      verdictDeliveries.filter((entry) => entry.rawBody.includes('"e2e-acq-dormant"')),
    ).toHaveLength(0);
  });
});
