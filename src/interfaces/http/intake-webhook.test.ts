import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { importIdFor } from '../../application/import/use-cases.js';
import { silentLogger, testWiring } from '../__fixtures__/wiring.js';
import type { TestWiring } from '../__fixtures__/wiring.js';
import { buildHttpApp } from './app.js';
import { INTAKE_WEBHOOK_PATH } from './intake-webhook.js';

/**
 * The signed acquisition receiver, driven through the fully built app (config-active wiring):
 * signature-first, tolerant reading, durable acquisition convergence, re-rooting, and the response
 * taxonomy the sender's at-least-once retry relies on.
 */

const KEY_BYTES = Buffer.from('intake-signing-key-0123456789abc');
const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
const SOURCE_ROOT = '/downloads/import';
const INTAKE_ROOT = '/music/intake';
// The wiring's fixed clock: all deliveries are timestamped against it.
const NOW = new Date('2026-07-18T12:00:00.000Z');

function fulfilledBody(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    type: 'acquisition.fulfilled',
    timestamp: NOW.toISOString(),
    data: {
      acquisitionId: 'acq-1',
      target: {
        type: 'album',
        artist: 'Radiohead',
        title: 'Kid A',
        musicbrainzReleaseId: 'mb-release-1',
        year: 2000,
        trackCount: 2,
      },
      candidate: { username: 'peer1', path: 'peer1/x', sizeBytes: 1000 },
      location: `${SOURCE_ROOT}/Radiohead - Kid A`,
      files: [],
      ...overrides,
    },
  });
}

function signedHeaders(body: string, overrides: Partial<Record<string, string>> = {}) {
  const id = overrides['webhook-id'] ?? 'msg-1';
  const timestamp = overrides['webhook-timestamp'] ?? String(Math.floor(NOW.getTime() / 1000));
  const signature =
    overrides['webhook-signature'] ??
    `v1,${createHmac('sha256', KEY_BYTES).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': signature,
  };
}

let app: FastifyInstance;

afterEach(async () => {
  await app.close();
});

interface IntakeTestOptions {
  readonly directoryExists?: (directory: string) => Promise<boolean>;
}

async function build(options: IntakeTestOptions = {}): Promise<TestWiring & { probed: string[] }> {
  const wiring = testWiring();
  const probed: string[] = [];
  app = await buildHttpApp(wiring.deps, silentLogger(), '0.0.0-test', {
    intake: {
      secret: SECRET,
      sourceRoot: SOURCE_ROOT,
      intakeRoot: INTAKE_ROOT,
      directoryExists: (directory) => {
        probed.push(directory);
        return (options.directoryExists ?? (() => Promise.resolve(true)))(directory);
      },
    },
  });
  return { ...wiring, probed };
}

function deliver(body: string, headers: Record<string, string> = signedHeaders(body)) {
  return app.inject({ method: 'POST', url: INTAKE_WEBHOOK_PATH, headers, payload: body });
}

describe('signature verification precedes everything', () => {
  it('rejects a delivery signed with the wrong key without acting on it', async () => {
    const wiring = await build();
    const body = fulfilledBody();
    const res = await deliver(
      body,
      signedHeaders(body, { 'webhook-signature': 'v1,bm90LXRoaXMtc2lnbmF0dXJl' }),
    );
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'InvalidSignature' });
    expect(wiring.probed).toEqual([]);
    expect(wiring.store.all()).toHaveLength(0);
  });

  it('rejects missing headers and stale timestamps as 401', async () => {
    await build();
    const body = fulfilledBody();

    const { 'webhook-id': _dropped, ...withoutId } = signedHeaders(body);
    const missing = await deliver(body, withoutId);
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ error: 'MissingHeader' });

    const staleAt = String(Math.floor(NOW.getTime() / 1000) - 301);
    const stale = await deliver(body, signedHeaders(body, { 'webhook-timestamp': staleAt }));
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toEqual({ error: 'StaleTimestamp' });
  });
});

describe('an accepted acquisition.fulfilled delivery', () => {
  it('submits the re-rooted import with the sender hints and the acquisition source', async () => {
    const wiring = await build();
    const res = await deliver(fulfilledBody());

    expect(res.statusCode).toBe(204);
    expect(wiring.probed).toEqual([`${INTAKE_ROOT}/Radiohead - Kid A`]);
    expect(wiring.store.all()).toHaveLength(1);
    expect(wiring.store.all()[0]!.event).toEqual({
      type: 'ImportRequested',
      directory: `${INTAKE_ROOT}/Radiohead - Kid A`,
      hints: { mbReleaseId: 'mb-release-1', artist: 'Radiohead', album: 'Kid A' },
      policy: wiring.deps.policy,
      source: {
        acquisitionId: 'acq-1',
        candidate: { username: 'peer1', path: 'peer1/x', sizeBytes: 1000 },
      },
    });
    wiring.sync();
    expect(wiring.status.get(importIdFor(`${INTAKE_ROOT}/Radiohead - Kid A`))?.phase).toBe(
      'requested',
    );
  });

  it('submits without a retained candidate when the delivery carries none', async () => {
    const wiring = await build();
    const res = await deliver(fulfilledBody({ candidate: undefined }));

    expect(res.statusCode).toBe(204);
    expect(wiring.store.all()[0]!.event).toMatchObject({
      type: 'ImportRequested',
      source: { acquisitionId: 'acq-1', candidate: undefined },
    });
  });

  it('converges a redelivered acquisition without probing the filesystem again', async () => {
    const wiring = await build();
    await deliver(fulfilledBody());
    wiring.sync();

    const again = await deliver(fulfilledBody());
    expect(again.statusCode).toBe(204);
    expect(wiring.store.all()).toHaveLength(1);
    expect(wiring.probed).toHaveLength(1); // only the first delivery touched the filesystem
  });

  it('maps store faults and append races for the sender to retry', async () => {
    const wiring = await build();
    wiring.store.failReads = true;
    const infra = await deliver(fulfilledBody());
    expect(infra.statusCode).toBe(500);
    expect(infra.json()).toEqual({ error: 'InfraError' });

    wiring.store.failReads = false;
    wiring.store.conflictOnAppend = true;
    const race = await deliver(fulfilledBody());
    expect(race.statusCode).toBe(409);
    expect(race.json()).toEqual({ error: 'ConcurrencyConflict' });
  });
});

describe('tolerant reading and dispatch', () => {
  it('acknowledges and ignores an unknown event type', async () => {
    const wiring = await build();
    const body = JSON.stringify({ type: 'acquisition.abandoned', data: { acquisitionId: 'x' } });
    const res = await deliver(body);
    expect(res.statusCode).toBe(204);
    expect(wiring.store.all()).toHaveLength(0);
  });

  it('rejects malformed JSON, a typeless envelope, and a schema violation as 400', async () => {
    const wiring = await build();
    for (const body of [
      'not-json{',
      JSON.stringify({ data: {} }),
      JSON.stringify({ type: 'acquisition.fulfilled', data: { acquisitionId: 'acq-1' } }),
    ]) {
      const res = await deliver(body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'InvalidPayload' });
    }
    expect(wiring.store.all()).toHaveLength(0);
  });

  it('rejects a location outside the source root without touching the filesystem', async () => {
    const wiring = await build();
    const res = await deliver(fulfilledBody({ location: '/elsewhere/Radiohead - Kid A' }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'OutsideSourceRoot' });
    expect(wiring.probed).toEqual([]);
  });

  it('answers 503 for a not-yet-visible directory so the sender redelivers', async () => {
    const wiring = await build({ directoryExists: () => Promise.resolve(false) });
    const res = await deliver(fulfilledBody());
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'IntakeDirectoryMissing' });
    expect(wiring.store.all()).toHaveLength(0);
  });
});

describe('config-dormant registration', () => {
  it('does not expose the route when no intake options are configured', async () => {
    const wiring = testWiring();
    app = await buildHttpApp(wiring.deps, silentLogger(), '0.0.0-test');
    const body = fulfilledBody();
    const res = await deliver(body);
    expect(res.statusCode).toBe(404);
  });
});
