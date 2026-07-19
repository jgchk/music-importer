import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  additivityViolations,
  generateJsonSchema,
  historyDir,
  historySnapshots,
  latestSchemaPath,
  publishedEventSchemas,
} from './event-schemas.js';

/**
 * `pnpm contracts:events` — (re)generate the committed JSON Schema artifacts from the zod sources.
 * Refuses a non-additive change outright: the additive-only rule says a breaking payload change is
 * a new event type, never a mutation of an existing one. An accepted change writes the stable
 * latest artifact and appends a new, permanent history snapshot (which the contract-test gate then
 * verifies on every commit).
 */

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

let failed = false;

for (const source of publishedEventSchemas) {
  const next = generateJsonSchema(source);
  const latestPath = latestSchemaPath(source.type);
  const snapshots = historySnapshots(source.type);

  const previous =
    snapshots.length > 0
      ? (JSON.parse(readFileSync(snapshots.at(-1)!.path, 'utf8')) as unknown)
      : undefined;

  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) {
    console.log(`${source.type}: up to date (history v${String(snapshots.at(-1)!.version)})`);
    continue;
  }

  const violations = snapshots.flatMap((snapshot) =>
    additivityViolations(JSON.parse(readFileSync(snapshot.path, 'utf8')), next).map(
      (violation) => `  vs history v${String(snapshot.version)}: ${violation}`,
    ),
  );
  if (violations.length > 0) {
    console.error(`${source.type}: NON-ADDITIVE schema change refused:`);
    for (const violation of violations) console.error(violation);
    console.error('A breaking payload change must be published as a new event type.');
    failed = true;
    continue;
  }

  const version = (snapshots.at(-1)?.version ?? 0) + 1;
  mkdirSync(historyDir(source.type), { recursive: true });
  writeJson(latestPath, next);
  writeJson(join(historyDir(source.type), `${String(version)}.schema.json`), next);
  console.log(`${source.type}: wrote ${latestPath} (history v${String(version)})`);
}

if (failed) process.exit(1);
