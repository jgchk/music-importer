import { errAsync, okAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_APPLIED,
  DIRECTORY,
  FAILURE,
  INCUMBENT,
  awaitingMatchReview,
  candidate,
  proposed,
  requested,
  resolved,
} from '../../domain/import/__fixtures__/import-fixtures.js';
import type { ImportEvent } from '../../domain/import/events.js';
import type { Effect } from '../../domain/import/import.js';
import { infraError } from '../ports/errors.js';
import type { EffectPorts } from './interpreter.js';
import { interpretEffect } from './interpreter.js';
import { FakeEventStore, fixedClock } from '../__fixtures__/fakes.js';

const PROPOSE: Effect = { type: 'Propose', directory: DIRECTORY, searchId: 'mb-1' };
const APPLY: Effect = {
  type: 'Apply',
  directory: DIRECTORY,
  mode: { kind: 'candidate', ref: candidate().ref },
};
const DELETE: Effect = { type: 'DeleteIntake', directory: DIRECTORY };

function ports(overrides: Partial<EffectPorts> = {}): EffectPorts {
  return {
    tagger: {
      propose: vi.fn(() =>
        okAsync({ kind: 'proposal' as const, candidates: [candidate()], duplicates: [] }),
      ),
      apply: vi.fn(() =>
        okAsync({ kind: 'applied' as const, location: '/library/x', failures: [] }),
      ),
      validate: vi.fn(),
    },
    intake: { deleteRelease: vi.fn(() => okAsync(undefined)) },
    ...overrides,
  };
}

async function run(history: readonly ImportEvent[], effect: Effect, effectPorts: EffectPorts) {
  const store = new FakeEventStore();
  await store.append('imp-1', 0, history, { importId: 'imp-1', occurredAt: 't' });
  const deps = { store, clock: fixedClock(), ports: effectPorts };
  const result = await interpretEffect(deps, 'imp-1', effect);
  return { result, store };
}

describe('Propose', () => {
  it('feeds a proposal back as RecordProposal carrying the pinned id', async () => {
    const p = ports();
    const { result, store } = await run([requested()], PROPOSE, p);
    expect(p.tagger.propose).toHaveBeenCalledWith(DIRECTORY, {
      searchId: 'mb-1',
      searchArtist: undefined,
      searchAlbum: undefined,
    });
    expect(result._unsafeUnwrap().map((entry) => entry.type)).toEqual([
      'CandidatesProposed',
      'AutoApplySelected',
    ]);
    expect(store.all()[1]!.event).toMatchObject({ pinnedId: 'mb-1' });
  });

  it('dooms the import on a permanent propose refusal', async () => {
    const p = ports({
      tagger: {
        propose: vi.fn(() => okAsync({ kind: 'doomed' as const, reason: 'directory not found' })),
        apply: vi.fn(),
        validate: vi.fn(),
      },
    });
    const { result } = await run([requested()], PROPOSE, p);
    expect(result._unsafeUnwrap().map((entry) => entry.event)).toEqual([
      { type: 'ImportRejected', reason: 'directory not found', filesDeleted: false },
    ]);
  });

  it('propagates a propose infrastructure fault for the reactor to retry', async () => {
    const p = ports({
      tagger: {
        propose: vi.fn(() => errAsync(infraError('bridge.propose', 'spawn failed'))),
        apply: vi.fn(),
        validate: vi.fn(),
      },
    });
    const { result } = await run([requested()], PROPOSE, p);
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: 'InfraError' });
  });
});

describe('Apply', () => {
  const applyingHistory = [requested(), proposed([candidate()]), AUTO_APPLIED];

  it('records a clean apply', async () => {
    const p = ports();
    const { result } = await run(applyingHistory, APPLY, p);
    expect(p.tagger.apply).toHaveBeenCalledWith(DIRECTORY, APPLY.type === 'Apply' && APPLY.mode);
    expect(result._unsafeUnwrap().map((entry) => entry.event)).toEqual([
      { type: 'ImportApplied', location: '/library/x' },
    ]);
  });

  it('records an apply whose enrichment partially failed', async () => {
    const p = ports({
      tagger: {
        propose: vi.fn(),
        apply: vi.fn(() =>
          okAsync({ kind: 'applied' as const, location: '/library/x', failures: [FAILURE] }),
        ),
        validate: vi.fn(),
      },
    });
    const { result } = await run(applyingHistory, APPLY, p);
    expect(result._unsafeUnwrap().map((entry) => entry.type)).toEqual([
      'ImportApplied',
      'RemediationRequired',
    ]);
  });

  it('routes a duplicate skip back as a review', async () => {
    const p = ports({
      tagger: {
        propose: vi.fn(),
        apply: vi.fn(() =>
          okAsync({ kind: 'skipped-duplicate' as const, incumbents: [INCUMBENT] }),
        ),
        validate: vi.fn(),
      },
    });
    const { result } = await run(applyingHistory, APPLY, p);
    expect(result._unsafeUnwrap().map((entry) => entry.event)).toEqual([
      { type: 'ReviewRequired', cause: { kind: 'duplicate-review', incumbents: [INCUMBENT] } },
    ]);
  });

  it('dooms the import on a permanent apply refusal', async () => {
    const p = ports({
      tagger: {
        propose: vi.fn(),
        apply: vi.fn(() => okAsync({ kind: 'doomed' as const, reason: 'candidate vanished' })),
        validate: vi.fn(),
      },
    });
    const { result } = await run(applyingHistory, APPLY, p);
    expect(result._unsafeUnwrap().map((entry) => entry.event)).toEqual([
      { type: 'ImportRejected', reason: 'candidate vanished', filesDeleted: false },
    ]);
  });

  it('propagates an apply infrastructure fault', async () => {
    const p = ports({
      tagger: {
        propose: vi.fn(),
        apply: vi.fn(() => errAsync(infraError('bridge.apply', 'timeout'))),
        validate: vi.fn(),
      },
    });
    const { result } = await run(applyingHistory, APPLY, p);
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: 'InfraError' });
  });
});

describe('DeleteIntake', () => {
  const rejectHistory = [...awaitingMatchReview(), resolved({ kind: 'reject', reason: 'bad rip' })];

  it('records the rejection with the deletion marker after cleaning intake', async () => {
    const p = ports();
    const { result } = await run(rejectHistory, DELETE, p);
    expect(p.intake.deleteRelease).toHaveBeenCalledWith(DIRECTORY);
    expect(result._unsafeUnwrap().map((entry) => entry.event)).toEqual([
      { type: 'ImportRejected', reason: 'bad rip', filesDeleted: true },
    ]);
  });

  it('propagates a deletion infrastructure fault', async () => {
    const p = ports({
      intake: { deleteRelease: vi.fn(() => errAsync(infraError('intake.delete', 'EACCES'))) },
    });
    const { result } = await run(rejectHistory, DELETE, p);
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: 'InfraError' });
  });
});
