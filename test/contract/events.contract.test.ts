import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  additivityViolations,
  eventFixturesDir,
  generateJsonSchema,
  historySnapshots,
  latestSchemaPath,
  publishedEventSchemas,
} from '../../scripts/contracts/event-schemas.js';

/**
 * The outbound-event contract gate (change: outbound-release-verdicts). The zod schemas in
 * `src/interfaces/contracts/events/` are the producer-owned source of truth; this tier mechanizes
 * the evolution rule — additive-only within an event type; a breaking change is a new type:
 *
 *  1. the committed JSON Schema artifact is exactly what the zod source generates (freshness);
 *  2. the current schema is an additive superset of every committed history snapshot;
 *  3. every frozen payload fixture — kept permanently, across all versions — still parses.
 *
 * Runs on every commit via `pnpm test:contract` (part of `pnpm check` and the CI test job).
 * Regenerate artifacts with `pnpm contracts:events` after an (additive) schema change.
 */

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe.each(publishedEventSchemas)('published event contract: $type', (source) => {
  const latestPath = latestSchemaPath(source.type);

  it('has a committed JSON Schema artifact', () => {
    expect(existsSync(latestPath), `missing ${latestPath} — run pnpm contracts:events`).toBe(true);
  });

  it('committed JSON Schema matches the zod source (run pnpm contracts:events to regenerate)', () => {
    expect(readJson(latestPath)).toEqual(generateJsonSchema(source));
  });

  it('newest history snapshot equals the committed latest (history is append-only)', () => {
    const snapshots = historySnapshots(source.type);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(readJson(snapshots.at(-1)!.path)).toEqual(readJson(latestPath));
  });

  it('is additive over every committed history snapshot (a breaking change must be a new event type)', () => {
    for (const snapshot of historySnapshots(source.type)) {
      expect(
        additivityViolations(readJson(snapshot.path), readJson(latestPath)),
        `non-additive change vs ${snapshot.path}`,
      ).toEqual([]);
    }
  });

  it('parses every frozen payload fixture, of every historical version, with the current schema', () => {
    const dir = eventFixturesDir(source.type);
    const fixtures = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(fixtures.length).toBeGreaterThan(0);
    for (const name of fixtures) {
      const fixture = readJson(join(dir, name)) as { event: unknown };
      const parsed = source.schema.safeParse(fixture.event);
      expect(parsed.success, `${name}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
  });
});
