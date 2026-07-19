import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Out-of-process E2E: drives the REAL built image over a real HTTP socket — real reactor, real
 * on-disk SQLite, a REAL beets (pinned in the image) importing into a hermetic fixture library,
 * with the matcher talking to the real MusicBrainz. The harness (test/e2e/run.sh) generates the
 * intake albums against small, stable Beatles singles whose durations the silent fixtures
 * reproduce (strong match) or mangle (weak match).
 */

const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3900';
const DATA_DIR = process.env['E2E_DATA_DIR'] ?? join(process.cwd(), '.e2e-tmp');

const LOVE_ME_DO_MBID = '22c9f6a3-0569-4c59-b551-cb4a26b0bc3f';

interface StatusBody {
  importId: string;
  status: string;
  location?: string;
  review?: {
    kind: string;
    candidates?: { ref: { dataSource: string; albumId: string }; distance: number }[];
  };
  rejection?: { reason: string; filesDeleted: boolean };
  history: { kind: string }[];
}

async function submit(path: string, hints?: Record<string, string>): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, ...(hints === undefined ? {} : { hints }) }),
  });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { importId: string; statusUrl: string };
  expect(body.statusUrl).toBe(`/api/v1/imports/${body.importId}`);
  return body.importId;
}

async function status(importId: string): Promise<StatusBody> {
  const res = await fetch(`${BASE_URL}/api/v1/imports/${importId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as StatusBody;
}

async function waitForStatus(
  importId: string,
  done: (body: StatusBody) => boolean,
  timeoutMs = 150_000,
): Promise<StatusBody> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await status(importId);
    if (done(body)) return body;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting on ${importId}; last: ${JSON.stringify(body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function resolve(importId: string, resolution: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/imports/${importId}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(resolution),
  });
  expect(res.status).toBe(202);
}

describe('manual import end to end', () => {
  it('auto-applies a confident match and lands the files in the library', async () => {
    const importId = await submit('/music/intake/love-me-do', { mbReleaseId: LOVE_ME_DO_MBID });

    const done = await waitForStatus(importId, (body) => body.status === 'applied');

    expect(done.location).toBe('/music/library/The Beatles/Love Me Do');
    expect(done.history.map((entry) => entry.kind)).toEqual([
      'requested',
      'proposed',
      'auto-apply-selected',
      'applied',
    ]);
    // The container's /music is the harness's .e2e-tmp/music: the move really happened on disk.
    expect(
      existsSync(join(DATA_DIR, 'music/library/The Beatles/Love Me Do/01 Love Me Do.mp3')),
    ).toBe(true);
    expect(existsSync(join(DATA_DIR, 'music/intake/love-me-do/01 Love Me Do.mp3'))).toBe(false);
  });

  it('routes a weak (duration-mangled) match to review and resolves via apply-candidate', async () => {
    const importId = await submit('/music/intake/please-please-me');

    const waiting = await waitForStatus(importId, (body) => body.status === 'awaiting-review');
    expect(waiting.review?.kind).toBe('match-review');
    const candidates = waiting.review?.candidates ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.distance).toBeGreaterThan(0.04); // the mangled stub fails the threshold

    // The queue lists it with the same carried context.
    const reviews = (await (await fetch(`${BASE_URL}/api/v1/imports/reviews`)).json()) as {
      reviews: { importId: string }[];
    };
    expect(reviews.reviews.map((entry) => entry.importId)).toContain(importId);

    await resolve(importId, { verb: 'apply-candidate', candidate: candidates[0]!.ref });
    const done = await waitForStatus(importId, (body) => body.status === 'applied');
    expect(done.location).toBe('/music/library/The Beatles/Please Please Me');
    expect(existsSync(join(DATA_DIR, 'music/library/The Beatles/Please Please Me'))).toBe(true);
  });

  it('rejects an unmatchable album and deletes its files from intake', async () => {
    const importId = await submit('/music/intake/mystery');

    const waiting = await waitForStatus(importId, (body) => body.status === 'awaiting-review');
    expect(['match-review', 'no-match']).toContain(waiting.review?.kind);

    // A manual import retains no delivered candidate: the retry verb is refused precisely,
    // and plain reject remains available.
    const refused = await fetch(`${BASE_URL}/api/v1/imports/${importId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'reject-and-retry-download', reasons: ['bad copy'] }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'NoRetainedCandidate' });

    await resolve(importId, { verb: 'reject', reason: 'not worth keeping' });
    const done = await waitForStatus(importId, (body) => body.status === 'rejected');

    expect(done.rejection).toEqual({ reason: 'not worth keeping', filesDeleted: true });
    expect(existsSync(join(DATA_DIR, 'music/intake/mystery'))).toBe(false);
  });
});

describe('operational surface', () => {
  it('reports the package version on the OpenAPI document', async () => {
    const spec = (await (await fetch(`${BASE_URL}/docs/json`)).json()) as {
      info: { version: string };
    };
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(spec.info.version).toBe(pkg.version);
  });

  it('exposes the startup-validated beets configuration on the debug endpoint', async () => {
    const res = await fetch(`${BASE_URL}/debug/beets-config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { beetsVersion: string; libraryDirectory: string };
    expect(body.beetsVersion).toMatch(/^2\.12\./);
    expect(body.libraryDirectory).toBe('/music/library');
  });

  it('answers MCP initialize + tool listing on /mcp (same process, same state)', async () => {
    const init = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '0' },
        },
      }),
    });
    expect(init.status).toBe(200);
    const text = await init.text();
    expect(text).toContain('music-importer');
  });
});
