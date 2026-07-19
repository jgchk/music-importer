import { describe, expect, it } from 'vitest';
import {
  DIRECTORY,
  POLICY,
  awaitingMatchReview,
} from '../../domain/import/__fixtures__/import-fixtures.js';
import { FakeEventStore, fixedClock } from '../__fixtures__/fakes.js';
import { applyCommand } from './command-handler.js';

const clock = fixedClock();

function deps() {
  return { store: new FakeEventStore(), clock };
}

describe('applyCommand', () => {
  it('appends the events decided for a fresh stream, stamped with metadata', async () => {
    const d = deps();
    const result = await applyCommand(d, 'imp-1', {
      type: 'SubmitImport',
      directory: DIRECTORY,
      policy: POLICY,
    });
    const appended = result._unsafeUnwrap();
    expect(appended.map((entry) => entry.type)).toEqual(['ImportRequested']);
    expect(appended[0]!.metadata).toEqual({
      importId: 'imp-1',
      occurredAt: '2026-07-18T12:00:00.000Z',
    });
  });

  it('surfaces a domain error for a protocol violation', async () => {
    const d = deps();
    const result = await applyCommand(d, 'imp-1', {
      type: 'ResolveReview',
      resolution: { kind: 'import-as-is' },
    });
    expect(result._unsafeUnwrapErr()).toEqual({ kind: 'UnknownImport' });
  });

  it('appends nothing when decide ignores a stale command', async () => {
    const d = deps();
    await d.store.append('imp-1', 0, awaitingMatchReview(), {
      importId: 'imp-1',
      occurredAt: clock.now().toISOString(),
    });
    const before = d.store.all().length;
    const result = await applyCommand(d, 'imp-1', {
      type: 'RecordApplied',
      location: '/library/x',
      failures: [],
    });
    expect(result._unsafeUnwrap()).toEqual([]);
    expect(d.store.all().length).toBe(before);
  });

  it('propagates an infrastructure read failure', async () => {
    const d = deps();
    d.store.failReads = true;
    const result = await applyCommand(d, 'imp-1', {
      type: 'SubmitImport',
      directory: DIRECTORY,
      policy: POLICY,
    });
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: 'InfraError' });
  });
});
