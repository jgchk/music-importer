import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SOURCE, candidate } from '../../domain/import/__fixtures__/import-fixtures.js';
import { importIdFor, submitImport } from '../../application/import/use-cases.js';
import { infraError } from '../../application/ports/errors.js';
import { silentLogger, testWiring } from '../__fixtures__/wiring.js';
import type { TestWiring } from '../__fixtures__/wiring.js';
import { buildHttpApp, statusForCommandError } from './app.js';

const INTAKE = '/intake/Artist - Album';

let app: FastifyInstance;

afterEach(async () => {
  await app.close();
});

async function build(wiring: TestWiring = testWiring()): Promise<TestWiring> {
  app = await buildHttpApp(wiring.deps, silentLogger(), '0.0.0-test');
  return wiring;
}

/** Submit over HTTP and drive the stubbed propose dispatch, like the reactor would. */
async function submitAndPropose(wiring: TestWiring): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/imports',
    payload: { path: INTAKE },
  });
  const { importId } = res.json<{ importId: string }>();
  await wiring.dispatch(importId, { type: 'Propose', directory: INTAKE });
  return importId;
}

describe('POST /api/v1/imports', () => {
  it('accepts a submission with 202, an id, and a status URL', async () => {
    const wiring = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      payload: { path: INTAKE, hints: { mbReleaseId: 'mb-1' } },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json<{ importId: string; statusUrl: string }>();
    expect(body.importId).toBe(importIdFor(INTAKE));
    expect(body.statusUrl).toBe(`/api/v1/imports/${body.importId}`);
    wiring.sync();
    expect(wiring.status.get(body.importId)?.phase).toBe('requested');
  });

  it('rejects a submission missing its path with a schema-driven 400', async () => {
    await build();
    const res = await app.inject({ method: 'POST', url: '/api/v1/imports', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('maps an append race to 409', async () => {
    const wiring = await build();
    wiring.store.conflictOnAppend = true;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      payload: { path: INTAKE },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'ConcurrencyConflict' });
  });

  it('maps an infrastructure failure to 500', async () => {
    const wiring = await build();
    wiring.store.failReads = true;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imports',
      payload: { path: INTAKE },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'InfraError' });
  });
});

describe('GET /api/v1/imports', () => {
  it('lists imports with their status', async () => {
    const wiring = await build();
    const importId = await submitAndPropose(wiring);
    const res = await app.inject({ method: 'GET', url: '/api/v1/imports' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ imports: { importId: string; status: string }[] }>();
    expect(body.imports).toHaveLength(1);
    expect(body.imports[0]).toMatchObject({ importId, status: 'awaiting-review' });
  });
});

describe('GET /api/v1/imports/:id', () => {
  it('returns the status view with history and the open review', async () => {
    const wiring = await build();
    wiring.setProposal({
      kind: 'proposal',
      candidates: [candidate({ distance: 0.9 })],
      duplicates: [],
    });
    const importId = await submitAndPropose(wiring);

    const res = await app.inject({ method: 'GET', url: `/api/v1/imports/${importId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      status: string;
      review: { kind: string; candidates: unknown[] };
      history: { kind: string }[];
    }>();
    expect(body.status).toBe('awaiting-review');
    expect(body.review.kind).toBe('match-review');
    expect(body.review.candidates).toHaveLength(1);
    expect(body.history.map((entry) => entry.kind)).toEqual([
      'requested',
      'proposed',
      'review-required',
    ]);
  });

  it('returns 404 for an unknown import', async () => {
    await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/imports/imp-nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/v1/imports/reviews', () => {
  it('lists pending reviews with kind-specific context', async () => {
    const wiring = await build();
    const importId = await submitAndPropose(wiring); // stub default: no candidates → no-match

    const res = await app.inject({ method: 'GET', url: '/api/v1/imports/reviews' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      reviews: [{ importId, path: INTAKE, review: { kind: 'no-match' } }],
    });
  });
});

describe('POST /api/v1/imports/:id/review', () => {
  it('resolves an open review and the queue drains', async () => {
    const wiring = await build();
    wiring.setProposal({
      kind: 'proposal',
      candidates: [candidate({ distance: 0.9 })],
      duplicates: [],
    });
    const importId = await submitAndPropose(wiring);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/review`,
      payload: {
        verb: 'apply-candidate',
        candidate: { dataSource: 'MusicBrainz', albumId: 'album-1' },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ importId });

    wiring.sync();
    const reviews = await app.inject({ method: 'GET', url: '/api/v1/imports/reviews' });
    expect(reviews.json()).toEqual({ reviews: [] });
  });

  it('returns 404 for an unknown import', async () => {
    await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/imp-nope/review',
      payload: { verb: 'import-as-is' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'UnknownImport' });
  });

  it('returns 409 when the verb does not fit the review', async () => {
    const wiring = await build();
    const importId = await submitAndPropose(wiring);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/review`,
      payload: { verb: 'accept' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'InvalidResolution' });
  });

  it('refuses reject-and-retry-download on an import without a retained candidate (409)', async () => {
    const wiring = await build();
    const importId = await submitAndPropose(wiring); // manual submission: no source, no candidate

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/review`,
      payload: { verb: 'reject-and-retry-download', reasons: ['corrupt rip'] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'NoRetainedCandidate' });

    // Plain reject still resolves the review normally.
    const reject = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/review`,
      payload: { verb: 'reject' },
    });
    expect(reject.statusCode).toBe(202);
  });

  it('records the verdict beside the rejection for a downloader-delivered import', async () => {
    const wiring = await build();
    // A downloader-intake submission: the source carries the retained candidate.
    const submitted = await submitImport(wiring.deps, { directory: INTAKE, source: SOURCE });
    const importId = submitted._unsafeUnwrap().importId;
    await wiring.dispatch(importId, { type: 'Propose', directory: INTAKE });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/review`,
      payload: { verb: 'reject-and-retry-download', reasons: ['corrupt rip'] },
    });
    expect(res.statusCode).toBe(202);

    wiring.sync();
    const status = await app.inject({ method: 'GET', url: `/api/v1/imports/${importId}` });
    expect(status.statusCode).toBe(200);
    const history = status.json<{ history: { kind: string }[] }>().history;
    expect(history).toContainEqual({
      kind: 'review-resolved',
      resolution: 'reject-and-retry-download',
    });
    expect(history).toContainEqual({
      kind: 'release-verdict-recorded',
      acquisitionId: SOURCE.acquisitionId,
      reasons: ['corrupt rip'],
    });
  });

  it('rejects a malformed resolution with a schema-driven 400', async () => {
    const wiring = await build();
    const importId = await submitAndPropose(wiring);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/imports/${importId}/review`,
      payload: { verb: 'apply-candidate' }, // missing the candidate ref
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /debug/beets-config', () => {
  it('serves the effective beets configuration when supplied', async () => {
    const wiring = testWiring();
    const beetsConfig = {
      beetsVersion: '2.12.0',
      libraryDatabase: '/beets/library.db',
      libraryDirectory: '/music/library',
      plugins: ['musicbrainz'],
      overlay: { threaded: false },
    };
    app = await buildHttpApp(wiring.deps, silentLogger(), '0.0.0-test', { beetsConfig });
    const res = await app.inject({ method: 'GET', url: '/debug/beets-config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(beetsConfig);
  });

  it('answers 404 when no configuration was supplied', async () => {
    await build();
    const res = await app.inject({ method: 'GET', url: '/debug/beets-config' });
    expect(res.statusCode).toBe(404);
  });
});

describe('request identity', () => {
  it('honors an inbound x-request-id and mints one otherwise', async () => {
    await build();
    const traced = await app.inject({
      method: 'GET',
      url: '/api/v1/imports',
      headers: { 'x-request-id': 'trace-42' },
    });
    const minted = await app.inject({ method: 'GET', url: '/api/v1/imports' });
    expect(traced.statusCode).toBe(200);
    expect(minted.statusCode).toBe(200);
  });
});

describe('statusForCommandError', () => {
  it('maps each failure family to its status', () => {
    expect(statusForCommandError(infraError('x', 'boom'))).toBe(500);
    expect(statusForCommandError({ kind: 'UnknownImport' })).toBe(404);
    expect(statusForCommandError({ kind: 'NoOpenReview' })).toBe(409);
    expect(statusForCommandError({ kind: 'NoRetainedCandidate' })).toBe(409);
    expect(
      statusForCommandError({ kind: 'ConcurrencyConflict', streamId: 's', expectedVersion: 0 }),
    ).toBe(409);
  });
});
