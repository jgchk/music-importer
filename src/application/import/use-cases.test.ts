import { describe, expect, it } from 'vitest';
import {
  DIRECTORY,
  HINTS,
  POLICY,
  awaitingMatchReview,
  remediationHistory,
} from '../../domain/import/__fixtures__/import-fixtures.js';
import type { ImportEvent } from '../../domain/import/events.js';
import { ImportStatusProjection } from '../projections/read-models.js';
import { FakeEventStore, fixedClock } from '../__fixtures__/fakes.js';
import type { UseCaseDeps } from './use-cases.js';
import {
  findAcquisitionImport,
  getImport,
  importIdFor,
  listImports,
  listPendingReviews,
  resolveReview,
  submitImport,
} from './use-cases.js';

function deps(): UseCaseDeps & { store: FakeEventStore; status: ImportStatusProjection } {
  return {
    store: new FakeEventStore(),
    clock: fixedClock(),
    status: new ImportStatusProjection(),
    policy: POLICY,
  };
}

async function seed(d: ReturnType<typeof deps>, history: readonly ImportEvent[]): Promise<string> {
  const importId = importIdFor(DIRECTORY);
  await d.store.append(importId, 0, history, { importId, occurredAt: 't' });
  d.status.rebuild(d.store.all());
  return importId;
}

describe('importIdFor', () => {
  it('derives a stable, prefixed id from the directory', () => {
    expect(importIdFor('/intake/a')).toMatch(/^imp-[0-9a-f]{24}$/u);
    expect(importIdFor('/intake/a')).toBe(importIdFor('/intake/a'));
    expect(importIdFor('/intake/a')).not.toBe(importIdFor('/intake/b'));
  });

  it('normalizes trailing slashes so cosmetic variants share a stream', () => {
    expect(importIdFor('/intake/a/')).toBe(importIdFor('/intake/a'));
    expect(importIdFor('///')).toBe(importIdFor('/'));
  });
});

describe('submitImport', () => {
  it('keys the import by its directory and stamps hints and policy', async () => {
    const d = deps();
    const result = await submitImport(d, { directory: `${DIRECTORY}/`, hints: HINTS });
    const { importId } = result._unsafeUnwrap();
    expect(importId).toBe(importIdFor(DIRECTORY));
    expect(d.store.all()[0]!.event).toEqual({
      type: 'ImportRequested',
      directory: DIRECTORY,
      hints: HINTS,
      policy: POLICY,
    });
  });

  it('converges a resubmission of a live directory on the same import', async () => {
    const d = deps();
    await submitImport(d, { directory: DIRECTORY });
    const again = await submitImport(d, { directory: DIRECTORY });
    expect(again._unsafeUnwrap().importId).toBe(importIdFor(DIRECTORY));
    expect(d.store.all()).toHaveLength(1);
  });

  it('records the acquisition source so the linkage is queryable from the log', async () => {
    const d = deps();
    await submitImport(d, { directory: DIRECTORY, source: { acquisitionId: 'acq-1' } });
    expect(d.store.all()[0]!.event).toMatchObject({
      type: 'ImportRequested',
      source: { acquisitionId: 'acq-1' },
    });
    d.status.rebuild(d.store.all());
    expect(findAcquisitionImport(d, 'acq-1')).toBe(importIdFor(DIRECTORY));
    expect(findAcquisitionImport(d, 'acq-2')).toBeUndefined();
  });
});

describe('resolveReview', () => {
  it('records a resolution against the open review', async () => {
    const d = deps();
    const importId = await seed(d, awaitingMatchReview());
    const result = await resolveReview(d, importId, { kind: 'import-as-is' });
    expect(result.isOk()).toBe(true);
    expect(d.store.all().at(-1)!.type).toBe('ReviewResolved');
  });

  it('surfaces the domain refusal for an unknown import', async () => {
    const d = deps();
    const result = await resolveReview(d, 'imp-missing', { kind: 'import-as-is' });
    expect(result._unsafeUnwrapErr()).toEqual({ kind: 'UnknownImport' });
  });
});

describe('queries', () => {
  it('reads one import and lists them all', async () => {
    const d = deps();
    const importId = await seed(d, awaitingMatchReview());
    expect(getImport(d, importId)?.phase).toBe('awaiting-review');
    expect(getImport(d, 'imp-unknown')).toBeUndefined();
    expect(listImports(d).map((view) => view.importId)).toEqual([importId]);
  });

  it('lists pending reviews including remediation items', async () => {
    const d = deps();
    const importId = await seed(d, remediationHistory());
    const reviews = listPendingReviews(d);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      importId,
      directory: DIRECTORY,
      review: { cause: { kind: 'remediation-review' } },
    });
  });
});
