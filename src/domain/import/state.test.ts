import { describe, expect, it } from 'vitest';
import {
  APPLIED,
  AUTO_APPLIED,
  DELIVERED_CANDIDATE,
  DIRECTORY,
  FAILURE,
  MANUAL_TAGS,
  MATCH_REVIEW,
  POLICY,
  REMEDIATION,
  SOURCE,
  appliedHistory,
  awaitingMatchReview,
  awaitingReviewWithCandidate,
  candidate,
  proposed,
  remediationHistory,
  requested,
  resolved,
} from './__fixtures__/import-fixtures.js';
import type { ImportEvent } from './events.js';
import { candidateRefKey } from './events.js';
import { evolve, foldEvents, initialState, isTerminal } from './state.js';

const REJECTED: ImportEvent = { type: 'ImportRejected', reason: 'no good', filesDeleted: true };

describe('candidateRefKey', () => {
  it('keys a candidate by its (data_source, album_id) pair', () => {
    expect(candidateRefKey({ dataSource: 'MusicBrainz', albumId: 'a1' })).toBe('MusicBrainz:a1');
  });
});

describe('evolve — the tolerant, total fold', () => {
  it('starts a fresh cycle from empty on ImportRequested', () => {
    const state = foldEvents([requested()]);
    expect(state).toMatchObject({ phase: 'requested', directory: DIRECTORY, policy: POLICY });
  });

  it('ignores a second ImportRequested while the import is live', () => {
    const live = foldEvents(awaitingMatchReview());
    expect(evolve(live, requested())).toBe(live);
  });

  it('starts a fresh cycle from a terminal rejected state', () => {
    const state = foldEvents([...awaitingMatchReview(), resolved({ kind: 'reject' }), REJECTED]);
    expect(state.phase).toBe('rejected');
    expect(evolve(state, requested())).toMatchObject({ phase: 'requested', candidates: [] });
  });

  it('starts a fresh cycle from a terminal applied state', () => {
    const state = foldEvents(appliedHistory());
    expect(evolve(state, requested())).toMatchObject({ phase: 'requested' });
  });

  it('records proposed candidates without advancing the phase', () => {
    const state = foldEvents([requested(), proposed([candidate()])]);
    expect(state).toMatchObject({ phase: 'requested', candidates: [candidate()] });
  });

  it('ignores CandidatesProposed outside a proposing phase', () => {
    const state = foldEvents(appliedHistory());
    expect(evolve(state, proposed([candidate()]))).toBe(state);
  });

  it('moves to applying with the selected candidate on AutoApplySelected', () => {
    const state = foldEvents([requested(), proposed([candidate()]), AUTO_APPLIED]);
    expect(state).toMatchObject({
      phase: 'applying',
      mode: { kind: 'candidate', ref: { dataSource: 'MusicBrainz', albumId: 'album-1' } },
      candidates: [candidate()],
    });
  });

  it('ignores AutoApplySelected outside a proposing phase', () => {
    const state = foldEvents(appliedHistory());
    expect(evolve(state, AUTO_APPLIED)).toBe(state);
  });

  it('moves to awaiting-review carrying the candidate list on ReviewRequired', () => {
    const state = foldEvents(awaitingMatchReview());
    expect(state).toMatchObject({
      phase: 'awaiting-review',
      cause: { kind: 'match-review' },
      candidates: [candidate({ distance: 0.5 })],
    });
  });

  it('moves from applying to awaiting-review on an apply-time duplicate ReviewRequired', () => {
    const state = foldEvents([
      requested(),
      proposed([candidate()]),
      AUTO_APPLIED,
      { type: 'ReviewRequired', cause: { kind: 'duplicate-review', incumbents: [] } },
    ]);
    expect(state).toMatchObject({ phase: 'awaiting-review', cause: { kind: 'duplicate-review' } });
  });

  it('ignores ReviewRequired in a terminal phase', () => {
    const state = foldEvents(appliedHistory());
    expect(evolve(state, MATCH_REVIEW)).toBe(state);
  });

  describe('ReviewResolved in awaiting-review', () => {
    it.each([
      [
        'apply-candidate',
        resolved({
          kind: 'apply-candidate',
          ref: { dataSource: 'MusicBrainz', albumId: 'album-1' },
          duplicateAction: 'replace',
        }),
        { kind: 'candidate', duplicateAction: 'replace' },
      ],
      ['import-as-is', resolved({ kind: 'import-as-is' }), { kind: 'as-is' }],
      [
        'manual-tags',
        resolved({ kind: 'manual-tags', tags: MANUAL_TAGS }),
        { kind: 'manual-tags', tags: MANUAL_TAGS },
      ],
    ] as const)('moves to applying on %s', (_name, event, mode) => {
      const state = foldEvents([...awaitingMatchReview(), event]);
      expect(state).toMatchObject({ phase: 'applying', mode });
    });

    it('moves back to proposing pinned to the supplied id', () => {
      const state = foldEvents([
        ...awaitingMatchReview(),
        resolved({ kind: 'supply-id', mbReleaseId: 'mb-2' }),
      ]);
      expect(state).toMatchObject({ phase: 'proposing', pinnedId: 'mb-2' });
    });

    it('moves back to proposing unpinned on refresh-candidates', () => {
      const state = foldEvents([
        ...awaitingMatchReview(),
        resolved({ kind: 'refresh-candidates' }),
      ]);
      expect(state).toMatchObject({ phase: 'proposing' });
      expect('pinnedId' in state && state.pinnedId).toBeFalsy();
    });

    it('settles the review but holds the phase on reject (deletion still owed)', () => {
      const state = foldEvents([...awaitingMatchReview(), resolved({ kind: 'reject' })]);
      expect(state).toMatchObject({ phase: 'awaiting-review', settled: { kind: 'reject' } });
    });

    it('settles the review but holds the phase on reject-and-retry-download', () => {
      const state = foldEvents([
        ...awaitingReviewWithCandidate(),
        resolved({ kind: 'reject-and-retry-download', reasons: ['corrupt rip'] }),
      ]);
      expect(state).toMatchObject({
        phase: 'awaiting-review',
        settled: { kind: 'reject-and-retry-download' },
      });
    });

    it('tolerates a remediation verb folded into a match review as a settlement', () => {
      const state = foldEvents([...awaitingMatchReview(), resolved({ kind: 'accept' })]);
      expect(state).toMatchObject({ phase: 'awaiting-review', settled: { kind: 'accept' } });
    });

    it('ignores a resolution once the review is settled', () => {
      const settledState = foldEvents([...awaitingMatchReview(), resolved({ kind: 'reject' })]);
      expect(evolve(settledState, resolved({ kind: 'import-as-is' }))).toBe(settledState);
    });
  });

  describe('ReviewResolved on an applied import (remediation)', () => {
    it('closes the remediation on accept', () => {
      const state = foldEvents([...remediationHistory(), resolved({ kind: 'accept' })]);
      expect(state).toMatchObject({ phase: 'applied' });
      expect('remediation' in state ? state.remediation : null).toBeUndefined();
    });

    it('marks the remediation retrying on retry-enrichment', () => {
      const state = foldEvents([...remediationHistory(), resolved({ kind: 'retry-enrichment' })]);
      expect(state).toMatchObject({
        phase: 'applied',
        remediation: { failures: [FAILURE], status: 'retrying' },
      });
    });

    it('ignores a resolution when no remediation is open', () => {
      const state = foldEvents(appliedHistory());
      expect(evolve(state, resolved({ kind: 'accept' }))).toBe(state);
    });

    it('ignores a resolution while a retry is already in flight', () => {
      const state = foldEvents([...remediationHistory(), resolved({ kind: 'retry-enrichment' })]);
      expect(evolve(state, resolved({ kind: 'accept' }))).toBe(state);
    });
  });

  it('moves applying to applied on ImportApplied, retaining the mode', () => {
    const state = foldEvents(appliedHistory());
    expect(state).toMatchObject({
      phase: 'applied',
      location: '/library/Artist/Album',
      mode: { kind: 'candidate' },
    });
  });

  it('refreshes an applied import and clears remediation on a re-applied ImportApplied', () => {
    const state = foldEvents([
      ...remediationHistory(),
      resolved({ kind: 'retry-enrichment' }),
      { type: 'ImportApplied', location: '/library/Artist/Album (2)' },
    ]);
    expect(state).toMatchObject({ phase: 'applied', location: '/library/Artist/Album (2)' });
    expect('remediation' in state ? state.remediation : null).toBeUndefined();
  });

  it('ignores ImportApplied outside applying/applied', () => {
    const state = foldEvents([requested()]);
    expect(evolve(state, APPLIED)).toBe(state);
  });

  it('opens a remediation on RemediationRequired', () => {
    const state = foldEvents(remediationHistory());
    expect(state).toMatchObject({
      phase: 'applied',
      remediation: { failures: [FAILURE], status: 'open' },
    });
  });

  it('ignores RemediationRequired outside applied', () => {
    const state = foldEvents([requested()]);
    expect(evolve(state, REMEDIATION)).toBe(state);
  });

  it('lands rejected with the deletion marker on ImportRejected', () => {
    const state = foldEvents([...awaitingMatchReview(), resolved({ kind: 'reject' }), REJECTED]);
    expect(state).toMatchObject({ phase: 'rejected', reason: 'no good', filesDeleted: true });
  });

  it('ignores ImportRejected on empty and terminal states', () => {
    expect(evolve(initialState, REJECTED)).toBe(initialState);
    const applied = foldEvents(appliedHistory());
    expect(evolve(applied, REJECTED)).toBe(applied);
  });

  it('retains the submission source — delivered candidate included — across phases', () => {
    const reviewing = foldEvents(awaitingReviewWithCandidate());
    expect(reviewing).toMatchObject({ phase: 'awaiting-review', source: SOURCE });
    const rejected = foldEvents([
      ...awaitingReviewWithCandidate(),
      resolved({ kind: 'reject-and-retry-download' }),
      REJECTED,
    ]);
    expect(rejected).toMatchObject({ phase: 'rejected', source: SOURCE });
  });

  it('folds a legacy ImportRequested without a source to no retained candidate', () => {
    const state = foldEvents(awaitingMatchReview());
    expect('source' in state ? state.source : null).toBeUndefined();
  });

  it('ignores ReleaseVerdictRecorded — a record-only fact — in any phase', () => {
    const verdict: ImportEvent = {
      type: 'ReleaseVerdictRecorded',
      acquisitionId: 'acq-1',
      candidate: DELIVERED_CANDIDATE,
      reasons: ['corrupt rip'],
    };
    const settledState = foldEvents([
      ...awaitingReviewWithCandidate(),
      resolved({ kind: 'reject-and-retry-download' }),
    ]);
    expect(evolve(settledState, verdict)).toBe(settledState);
    expect(evolve(initialState, verdict)).toBe(initialState);
  });
});

describe('isTerminal', () => {
  it('treats applied and rejected as terminal, live phases as not', () => {
    expect(isTerminal(initialState)).toBe(false);
    expect(isTerminal(foldEvents(awaitingMatchReview()))).toBe(false);
    expect(isTerminal(foldEvents(appliedHistory()))).toBe(true);
    expect(
      isTerminal(foldEvents([...awaitingMatchReview(), resolved({ kind: 'reject' }), REJECTED])),
    ).toBe(true);
  });
});
