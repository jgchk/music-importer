import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { silentLogger, testWiring } from '../__fixtures__/wiring.js';
import { buildHttpApp } from './app.js';

/**
 * The breaking-change guard: the generated OpenAPI document is the single derived contract for
 * the HTTP surface. Snapshotting the whole document fails CI on any drift — a removed endpoint, a
 * renamed field, a changed type — so a breaking change cannot ship under `/api/v1` unless the
 * snapshot is deliberately updated.
 */

/**
 * `info.version` reports the application's release version and so changes on every release; it is
 * not part of the frozen HTTP contract (the `/api/v1` path prefix is). Normalizing it keeps the
 * breaking-change snapshot stable across releases while still guarding every endpoint, field, and
 * type.
 */
type OpenApiDoc = { openapi: string; info: { version: string }; paths: Record<string, unknown> };

function normalizeVersion(spec: OpenApiDoc): OpenApiDoc {
  return { ...spec, info: { ...spec.info, version: '0.0.0' } };
}

describe('OpenAPI contract', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildHttpApp(testWiring().deps, silentLogger(), '0.0.0-test');
  });

  afterEach(async () => {
    await app.close();
  });

  it('exposes every v1 import endpoint under the version prefix', () => {
    const spec = app.swagger() as OpenApiDoc;

    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/api/v1/imports',
      '/api/v1/imports/reviews',
      '/api/v1/imports/{id}',
      '/api/v1/imports/{id}/review',
    ]);
  });

  it('reports the injected release version as info.version', () => {
    expect((app.swagger() as OpenApiDoc).info.version).toBe('0.0.0-test');
  });

  it('matches the published contract snapshot (version-normalized)', () => {
    expect(normalizeVersion(app.swagger() as OpenApiDoc)).toMatchSnapshot();
  });

  it('a release version bump alone does not change the contract', async () => {
    const bumped = await buildHttpApp(testWiring().deps, silentLogger(), '99.99.99');
    try {
      expect(normalizeVersion(bumped.swagger() as OpenApiDoc)).toEqual(
        normalizeVersion(app.swagger() as OpenApiDoc),
      );
    } finally {
      await bumped.close();
    }
  });

  it('serves the OpenAPI JSON document', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ openapi: string }>().openapi).toMatch(/^3\./);
  });
});
