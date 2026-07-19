import { describe, expect, it } from 'vitest';
import {
  APPLIED,
  AUTO_APPLIED,
  DELIVERED_CANDIDATE,
  DIRECTORY,
  FAILURE,
  HINTS,
  INCUMBENT,
  MANUAL_TAGS,
  MATCH_REVIEW,
  POLICY,
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
import type { ImportCommand } from './commands.js';
import type { ImportEvent } from './events.js';
import { Import } from './import.js';

const SUBMIT: ImportCommand = { type: 'SubmitImport', directory: DIRECTORY, policy: POLICY };
const REJECTED: ImportEvent = { type: 'ImportRejected', reason: 'gone', filesDeleted: false };

function given(events: readonly ImportEvent[]): Import {
  return Import.fromHistory(events);
}

describe('submission', () => {
  it('accepts a submission on an empty stream', () => {
    const events = given([]).execute(SUBMIT)._unsafeUnwrap();
    expect(events).toEqual([
      { type: 'ImportRequested', directory: DIRECTORY, hints: undefined, policy: POLICY },
    ]);
  });

  it('stamps hints onto the request', () => {
    const events = given([])
      .execute({ ...SUBMIT, hints: HINTS })
      ._unsafeUnwrap();
    expect(events[0]).toMatchObject({ type: 'ImportRequested', hints: HINTS });
  });

  it('stamps the acquisition source onto an event-driven request', () => {
    const events = given([])
      .execute({ ...SUBMIT, source: { acquisitionId: 'acq-1' } })
      ._unsafeUnwrap();
    expect(events[0]).toMatchObject({
      type: 'ImportRequested',
      source: { acquisitionId: 'acq-1' },
    });
  });

  it('stamps the delivered candidate onto the source when the sender carried one', () => {
    const events = given([])
      .execute({ ...SUBMIT, source: SOURCE })
      ._unsafeUnwrap();
    expect(events[0]).toMatchObject({ type: 'ImportRequested', source: SOURCE });
  });

  it('converges on a duplicate submission while the import is live', () => {
    expect(given(awaitingMatchReview()).execute(SUBMIT)._unsafeUnwrap()).toEqual([]);
  });

  it('starts a fresh cycle when the prior import is terminal', () => {
    const events = given(appliedHistory()).execute(SUBMIT)._unsafeUnwrap();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'ImportRequested' });
  });
});

describe('recording a proposal', () => {
  const record = (
    candidates: Parameters<typeof proposed>[0],
    duplicates: Parameters<typeof proposed>[1] = [],
    pinnedId?: string,
  ): ImportCommand => ({ type: 'RecordProposal', candidates, duplicates, pinnedId });

  it('auto-applies the best candidate at or under the threshold', () => {
    const strong = candidate({ distance: 0.02 });
    const weaker = candidate({
      ref: { dataSource: 'MusicBrainz', albumId: 'album-2' },
      distance: 0.4,
    });
    const events = given([requested()])
      .execute(record([weaker, strong]))
      ._unsafeUnwrap();
    expect(events).toEqual([
      {
        type: 'CandidatesProposed',
        candidates: [weaker, strong],
        duplicates: [],
        pinnedId: undefined,
      },
      { type: 'AutoApplySelected', ref: strong.ref, distance: 0.02 },
    ]);
    // Order-independent: the best candidate wins from either position.
    const reversed = given([requested()])
      .execute(record([strong, weaker]))
      ._unsafeUnwrap();
    expect(reversed[1]).toMatchObject({ type: 'AutoApplySelected', ref: strong.ref });
  });

  it('routes a weak match to review with the best candidate named', () => {
    const weak = candidate({ distance: 0.6 });
    const events = given([requested()])
      .execute(record([weak]))
      ._unsafeUnwrap();
    expect(events[1]).toEqual({
      type: 'ReviewRequired',
      cause: { kind: 'match-review', hinted: false, best: weak.ref },
    });
  });

  it('marks a hint-contradicted weak match as hinted (distance governs, D4)', () => {
    const weak = candidate({ distance: 0.6 });
    const events = given([requested({ hints: HINTS })])
      .execute(record([weak]))
      ._unsafeUnwrap();
    expect(events[1]).toMatchObject({ cause: { kind: 'match-review', hinted: true } });
  });

  it('marks a pinned re-proposal as hinted via the supplied id', () => {
    const history = [
      ...awaitingMatchReview(),
      resolved({ kind: 'supply-id', mbReleaseId: 'mb-2' }),
    ];
    const events = given(history)
      .execute(record([candidate({ distance: 0.6 })]))
      ._unsafeUnwrap();
    expect(events[1]).toMatchObject({ cause: { kind: 'match-review', hinted: true } });
  });

  it('marks the proposal hinted when the interpreter reports the pinned id', () => {
    const events = given([requested()])
      .execute(record([candidate({ distance: 0.6 })], [], 'mb-9'))
      ._unsafeUnwrap();
    expect(events[0]).toMatchObject({ type: 'CandidatesProposed', pinnedId: 'mb-9' });
    expect(events[1]).toMatchObject({ cause: { hinted: true } });
  });

  it('routes no candidates to a no-match review, distinct from low confidence', () => {
    const events = given([requested()]).execute(record([]))._unsafeUnwrap();
    expect(events[1]).toEqual({ type: 'ReviewRequired', cause: { kind: 'no-match' } });
  });

  it('routes a strong match with an incumbent to duplicate review, never auto-replace', () => {
    const events = given([requested()])
      .execute(record([candidate({ distance: 0.01 })], [INCUMBENT]))
      ._unsafeUnwrap();
    expect(events[1]).toEqual({
      type: 'ReviewRequired',
      cause: { kind: 'duplicate-review', incumbents: [INCUMBENT] },
    });
  });

  it('drops a stale proposal after the stream moved on', () => {
    expect(
      given(appliedHistory())
        .execute(record([candidate()]))
        ._unsafeUnwrap(),
    ).toEqual([]);
  });
});

describe('recording an apply outcome', () => {
  it('lands applied cleanly when nothing failed', () => {
    const history = [requested(), proposed([candidate()]), AUTO_APPLIED];
    const events = given(history)
      .execute({ type: 'RecordApplied', location: '/library/A', failures: [] })
      ._unsafeUnwrap();
    expect(events).toEqual([{ type: 'ImportApplied', location: '/library/A' }]);
  });

  it('lands applied with a remediation review when enrichment failed (D7)', () => {
    const history = [requested(), proposed([candidate()]), AUTO_APPLIED];
    const events = given(history)
      .execute({ type: 'RecordApplied', location: '/library/A', failures: [FAILURE] })
      ._unsafeUnwrap();
    expect(events).toEqual([
      { type: 'ImportApplied', location: '/library/A' },
      { type: 'RemediationRequired', failures: [FAILURE] },
    ]);
  });

  it('accepts the outcome of an enrichment retry', () => {
    const history = [...remediationHistory(), resolved({ kind: 'retry-enrichment' })];
    const events = given(history)
      .execute({ type: 'RecordApplied', location: '/library/A', failures: [] })
      ._unsafeUnwrap();
    expect(events).toEqual([{ type: 'ImportApplied', location: '/library/A' }]);
  });

  it('drops a stale apply outcome', () => {
    expect(
      given([requested()])
        .execute({ type: 'RecordApplied', location: '/library/A', failures: [] })
        ._unsafeUnwrap(),
    ).toEqual([]);
    expect(
      given(appliedHistory())
        .execute({ type: 'RecordApplied', location: '/library/A', failures: [] })
        ._unsafeUnwrap(),
    ).toEqual([]);
  });

  it('routes an apply-time duplicate skip to duplicate review', () => {
    const history = [requested(), proposed([candidate()]), AUTO_APPLIED];
    const events = given(history)
      .execute({ type: 'RecordApplySkippedDuplicate', incumbents: [INCUMBENT] })
      ._unsafeUnwrap();
    expect(events).toEqual([
      { type: 'ReviewRequired', cause: { kind: 'duplicate-review', incumbents: [INCUMBENT] } },
    ]);
  });

  it('drops a stale duplicate-skip outcome', () => {
    expect(
      given(appliedHistory())
        .execute({ type: 'RecordApplySkippedDuplicate', incumbents: [] })
        ._unsafeUnwrap(),
    ).toEqual([]);
  });
});

describe('resolving a review', () => {
  const resolve = (resolution: Parameters<typeof resolved>[0]): ImportCommand => ({
    type: 'ResolveReview',
    resolution: (resolved(resolution) as Extract<ImportEvent, { type: 'ReviewResolved' }>)
      .resolution,
  });

  it('rejects a resolution for an unknown import', () => {
    expect(
      given([])
        .execute(resolve({ kind: 'import-as-is' }))
        ._unsafeUnwrapErr(),
    ).toEqual({
      kind: 'UnknownImport',
    });
  });

  it('rejects a resolution before any review exists', () => {
    expect(
      given([requested()])
        .execute(resolve({ kind: 'import-as-is' }))
        ._unsafeUnwrapErr(),
    ).toEqual({ kind: 'NoOpenReview' });
  });

  it('accepts each verb against an open match review', () => {
    for (const resolution of [
      { kind: 'apply-candidate', ref: candidate({ distance: 0.5 }).ref },
      { kind: 'supply-id', mbReleaseId: 'mb-2' },
      { kind: 'refresh-candidates' },
      { kind: 'manual-tags', tags: MANUAL_TAGS },
      { kind: 'import-as-is' },
      { kind: 'reject', reason: 'not this album' },
    ] as const) {
      const events = given(awaitingMatchReview()).execute(resolve(resolution))._unsafeUnwrap();
      expect(events).toEqual([{ type: 'ReviewResolved', resolution }]);
    }
  });

  it('refuses to apply a candidate that was never proposed', () => {
    const error = given(awaitingMatchReview())
      .execute(
        resolve({ kind: 'apply-candidate', ref: { dataSource: 'Discogs', albumId: 'nope' } }),
      )
      ._unsafeUnwrapErr();
    expect(error).toEqual({ kind: 'UnknownCandidate', candidate: 'Discogs:nope' });
  });

  it('refuses remediation verbs on a non-remediation review', () => {
    const error = given(awaitingMatchReview())
      .execute(resolve({ kind: 'accept' }))
      ._unsafeUnwrapErr();
    expect(error).toMatchObject({ kind: 'InvalidResolution' });
  });

  it('mints the release verdict beside the rejection on reject-and-retry-download', () => {
    const resolution = {
      kind: 'reject-and-retry-download',
      reasons: ['corrupt rip', 'transcode'],
    } as const;
    const events = given(awaitingReviewWithCandidate())
      .execute(resolve(resolution))
      ._unsafeUnwrap();
    expect(events).toEqual([
      { type: 'ReviewResolved', resolution },
      {
        type: 'ReleaseVerdictRecorded',
        acquisitionId: SOURCE.acquisitionId,
        candidate: DELIVERED_CANDIDATE,
        reasons: ['corrupt rip', 'transcode'],
      },
    ]);
  });

  it('defaults the verdict reasons to an empty list when none are given', () => {
    const events = given(awaitingReviewWithCandidate())
      .execute(resolve({ kind: 'reject-and-retry-download' }))
      ._unsafeUnwrap();
    expect(events[1]).toMatchObject({ type: 'ReleaseVerdictRecorded', reasons: [] });
  });

  it('refuses reject-and-retry-download without a retained candidate', () => {
    // A manual import has no source at all; a legacy intake import has a source but no candidate.
    expect(
      given(awaitingMatchReview())
        .execute(resolve({ kind: 'reject-and-retry-download' }))
        ._unsafeUnwrapErr(),
    ).toEqual({ kind: 'NoRetainedCandidate' });
    const legacy = [
      requested({ source: { acquisitionId: 'acq-legacy' } }),
      proposed([candidate({ distance: 0.5 })]),
      MATCH_REVIEW,
    ];
    expect(
      given(legacy)
        .execute(resolve({ kind: 'reject-and-retry-download' }))
        ._unsafeUnwrapErr(),
    ).toEqual({ kind: 'NoRetainedCandidate' });
    // Plain reject still resolves the same review normally.
    expect(
      given(legacy)
        .execute(resolve({ kind: 'reject' }))
        ._unsafeUnwrap(),
    ).toEqual([{ type: 'ReviewResolved', resolution: { kind: 'reject' } }]);
  });

  it('no-ops a redelivered reject-and-retry-download of a settled review', () => {
    const history = [
      ...awaitingReviewWithCandidate(),
      resolved({ kind: 'reject-and-retry-download' }),
    ];
    expect(
      given(history)
        .execute(resolve({ kind: 'reject-and-retry-download' }))
        ._unsafeUnwrap(),
    ).toEqual([]);
  });

  it('no-ops a redelivered resolution of a settled review', () => {
    const history = [...awaitingMatchReview(), resolved({ kind: 'reject' })];
    expect(
      given(history)
        .execute(resolve({ kind: 'reject' }))
        ._unsafeUnwrap(),
    ).toEqual([]);
  });

  it('no-ops while a prior resolution is still in motion', () => {
    const reProposing = [...awaitingMatchReview(), resolved({ kind: 'refresh-candidates' })];
    expect(
      given(reProposing)
        .execute(resolve({ kind: 'import-as-is' }))
        ._unsafeUnwrap(),
    ).toEqual([]);
    const applying = [requested(), proposed([candidate()]), AUTO_APPLIED];
    expect(
      given(applying)
        .execute(resolve({ kind: 'import-as-is' }))
        ._unsafeUnwrap(),
    ).toEqual([]);
    const rejectedHistory = [...awaitingMatchReview(), resolved({ kind: 'reject' }), REJECTED];
    expect(
      given(rejectedHistory)
        .execute(resolve({ kind: 'import-as-is' }))
        ._unsafeUnwrap(),
    ).toEqual([]);
  });

  it('resolves an open remediation with accept or retry-enrichment only', () => {
    expect(
      given(remediationHistory())
        .execute(resolve({ kind: 'accept' }))
        ._unsafeUnwrap(),
    ).toEqual([{ type: 'ReviewResolved', resolution: { kind: 'accept' } }]);
    expect(
      given(remediationHistory())
        .execute(resolve({ kind: 'retry-enrichment' }))
        ._unsafeUnwrap(),
    ).toEqual([{ type: 'ReviewResolved', resolution: { kind: 'retry-enrichment' } }]);
    expect(
      given(remediationHistory())
        .execute(resolve({ kind: 'import-as-is' }))
        ._unsafeUnwrapErr(),
    ).toMatchObject({ kind: 'InvalidResolution' });
  });

  it('no-ops a resolution on an applied import without an open remediation', () => {
    expect(
      given(appliedHistory())
        .execute(resolve({ kind: 'accept' }))
        ._unsafeUnwrap(),
    ).toEqual([]);
  });
});

describe('recording rejection outcomes', () => {
  it('records the rejection with the deletion marker after intake was cleaned', () => {
    const history = [...awaitingMatchReview(), resolved({ kind: 'reject', reason: 'wrong rip' })];
    const events = given(history).execute({ type: 'RecordIntakeDeleted' })._unsafeUnwrap();
    expect(events).toEqual([{ type: 'ImportRejected', reason: 'wrong rip', filesDeleted: true }]);
  });

  it('defaults the rejection reason when none was given', () => {
    const history = [...awaitingMatchReview(), resolved({ kind: 'reject' })];
    const events = given(history).execute({ type: 'RecordIntakeDeleted' })._unsafeUnwrap();
    expect(events[0]).toMatchObject({ reason: 'rejected by review' });
  });

  it('records the rejection with joined reasons after a reject-and-retry-download', () => {
    const history = [
      ...awaitingReviewWithCandidate(),
      resolved({ kind: 'reject-and-retry-download', reasons: ['corrupt rip', 'transcode'] }),
    ];
    const events = given(history).execute({ type: 'RecordIntakeDeleted' })._unsafeUnwrap();
    expect(events).toEqual([
      { type: 'ImportRejected', reason: 'corrupt rip; transcode', filesDeleted: true },
    ]);
  });

  it('defaults the rejection reason when the retry verb carried no reasons', () => {
    const history = [
      ...awaitingReviewWithCandidate(),
      resolved({ kind: 'reject-and-retry-download' }),
    ];
    const events = given(history).execute({ type: 'RecordIntakeDeleted' })._unsafeUnwrap();
    expect(events[0]).toMatchObject({ reason: 'rejected by review' });
  });

  it('drops an intake-deletion report when the review settled on a non-rejecting verb', () => {
    const history = [...awaitingMatchReview(), resolved({ kind: 'accept' })];
    expect(given(history).execute({ type: 'RecordIntakeDeleted' })._unsafeUnwrap()).toEqual([]);
  });

  it('drops a stale intake-deletion report', () => {
    expect(
      given(awaitingMatchReview()).execute({ type: 'RecordIntakeDeleted' })._unsafeUnwrap(),
    ).toEqual([]);
    expect(given([requested()]).execute({ type: 'RecordIntakeDeleted' })._unsafeUnwrap()).toEqual(
      [],
    );
  });

  it('dooms a live import with its reason, files untouched', () => {
    const events = given([requested()])
      .execute({ type: 'RecordDoomed', reason: 'intake directory vanished' })
      ._unsafeUnwrap();
    expect(events).toEqual([
      { type: 'ImportRejected', reason: 'intake directory vanished', filesDeleted: false },
    ]);
  });

  it('drops a doom report on empty or terminal streams', () => {
    expect(given([]).execute({ type: 'RecordDoomed', reason: 'x' })._unsafeUnwrap()).toEqual([]);
    expect(
      given(appliedHistory()).execute({ type: 'RecordDoomed', reason: 'x' })._unsafeUnwrap(),
    ).toEqual([]);
  });
});

describe('react — the reflex', () => {
  it('fires Propose with the hints on ImportRequested', () => {
    const request = requested({ hints: HINTS });
    expect(given([request]).reactTo(request)).toEqual([
      {
        type: 'Propose',
        directory: DIRECTORY,
        searchId: HINTS.mbReleaseId,
        searchArtist: HINTS.artist,
        searchAlbum: HINTS.album,
      },
    ]);
  });

  it('fires Propose without pins on an unhinted request', () => {
    expect(given([requested()]).reactTo(requested())).toEqual([
      {
        type: 'Propose',
        directory: DIRECTORY,
        searchId: undefined,
        searchArtist: undefined,
        searchAlbum: undefined,
      },
    ]);
  });

  it('fires Apply on AutoApplySelected', () => {
    const history = [requested(), proposed([candidate()]), AUTO_APPLIED];
    expect(given(history).reactTo(AUTO_APPLIED)).toEqual([
      {
        type: 'Apply',
        directory: DIRECTORY,
        mode: { kind: 'candidate', ref: candidate().ref },
      },
    ]);
  });

  it('fires nothing for AutoApplySelected against a mismatched state', () => {
    expect(given([]).reactTo(AUTO_APPLIED)).toEqual([]);
  });

  it('fires Apply for each apply verb once resolved', () => {
    for (const resolution of [
      resolved({ kind: 'import-as-is' }),
      resolved({ kind: 'apply-candidate', ref: candidate().ref }),
      resolved({ kind: 'manual-tags', tags: MANUAL_TAGS }),
    ]) {
      const history = [...awaitingMatchReview(), resolution];
      const effects = given(history).reactTo(resolution);
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({ type: 'Apply', directory: DIRECTORY });
    }
  });

  it('fires nothing for an apply verb against a mismatched state', () => {
    expect(given([]).reactTo(resolved({ kind: 'import-as-is' }))).toEqual([]);
  });

  it('fires a pinned Propose on supply-id', () => {
    const resolution = resolved({ kind: 'supply-id', mbReleaseId: 'mb-2' });
    const history = [...awaitingMatchReview(), resolution];
    expect(given(history).reactTo(resolution)).toEqual([
      { type: 'Propose', directory: DIRECTORY, searchId: 'mb-2' },
    ]);
  });

  it('fires nothing for supply-id against a mismatched state', () => {
    expect(given([]).reactTo(resolved({ kind: 'supply-id', mbReleaseId: 'mb-2' }))).toEqual([]);
  });

  it('fires a fresh Propose on refresh-candidates', () => {
    const resolution = resolved({ kind: 'refresh-candidates' });
    const history = [...awaitingMatchReview(), resolution];
    expect(given(history).reactTo(resolution)).toEqual([{ type: 'Propose', directory: DIRECTORY }]);
  });

  it('fires nothing for refresh-candidates against a mismatched state', () => {
    expect(given([]).reactTo(resolved({ kind: 'refresh-candidates' }))).toEqual([]);
  });

  it('fires DeleteIntake on reject — the queue owns intake hygiene', () => {
    const resolution = resolved({ kind: 'reject' });
    const history = [...awaitingMatchReview(), resolution];
    expect(given(history).reactTo(resolution)).toEqual([
      { type: 'DeleteIntake', directory: DIRECTORY },
    ]);
  });

  it('fires nothing for reject against a mismatched state', () => {
    expect(given([]).reactTo(resolved({ kind: 'reject' }))).toEqual([]);
  });

  it('fires DeleteIntake on reject-and-retry-download — same hygiene as reject', () => {
    const resolution = resolved({ kind: 'reject-and-retry-download', reasons: ['corrupt rip'] });
    const history = [...awaitingReviewWithCandidate(), resolution];
    expect(given(history).reactTo(resolution)).toEqual([
      { type: 'DeleteIntake', directory: DIRECTORY },
    ]);
    expect(given([]).reactTo(resolution)).toEqual([]);
  });

  it('fires nothing on ReleaseVerdictRecorded — the publisher consumes it, not the reactor', () => {
    const verdict = {
      type: 'ReleaseVerdictRecorded',
      acquisitionId: SOURCE.acquisitionId,
      candidate: DELIVERED_CANDIDATE,
      reasons: [],
    } as const;
    const history = [
      ...awaitingReviewWithCandidate(),
      resolved({ kind: 'reject-and-retry-download' }),
      verdict,
    ];
    expect(given(history).reactTo(verdict)).toEqual([]);
  });

  it('fires an in-place Apply at the library location on retry-enrichment', () => {
    const resolution = resolved({ kind: 'retry-enrichment' });
    const history = [...remediationHistory(), resolution];
    expect(given(history).reactTo(resolution)).toEqual([
      {
        type: 'Apply',
        directory: '/library/Artist/Album',
        mode: { kind: 'candidate', ref: candidate().ref },
      },
    ]);
  });

  it('fires nothing for retry-enrichment against a mismatched state', () => {
    expect(given([]).reactTo(resolved({ kind: 'retry-enrichment' }))).toEqual([]);
  });

  it('fires nothing on accept', () => {
    const resolution = resolved({ kind: 'accept' });
    expect(given([...remediationHistory(), resolution]).reactTo(resolution)).toEqual([]);
  });

  it('fires nothing for record-only events', () => {
    const agg = given(appliedHistory());
    expect(agg.reactTo(proposed([]))).toEqual([]);
    expect(agg.reactTo(MATCH_REVIEW)).toEqual([]);
    expect(agg.reactTo(APPLIED)).toEqual([]);
    expect(agg.reactTo({ type: 'RemediationRequired', failures: [] })).toEqual([]);
    expect(agg.reactTo(REJECTED)).toEqual([]);
  });
});

describe('the snapshot projection', () => {
  it('exposes nothing but the phase for an empty stream', () => {
    expect(given([]).snapshot).toEqual({
      phase: 'empty',
      directory: undefined,
      location: undefined,
      openReview: undefined,
      rejection: undefined,
    });
  });

  it('exposes the open review with its carried candidates', () => {
    const snapshot = given(awaitingMatchReview()).snapshot;
    expect(snapshot.openReview).toEqual({
      cause: { kind: 'match-review', hinted: false, best: candidate().ref },
      candidates: [candidate({ distance: 0.5 })],
    });
  });

  it('hides the review once settled', () => {
    const snapshot = given([...awaitingMatchReview(), resolved({ kind: 'reject' })]).snapshot;
    expect(snapshot.openReview).toBeUndefined();
  });

  it('exposes an open remediation as a remediation review', () => {
    const snapshot = given(remediationHistory()).snapshot;
    expect(snapshot.phase).toBe('applied');
    expect(snapshot.openReview).toMatchObject({ cause: { kind: 'remediation-review' } });
  });

  it('hides a remediation while its retry is in flight', () => {
    const snapshot = given([
      ...remediationHistory(),
      resolved({ kind: 'retry-enrichment' }),
    ]).snapshot;
    expect(snapshot.openReview).toBeUndefined();
  });

  it('exposes the library location once applied', () => {
    const snapshot = given(appliedHistory()).snapshot;
    expect(snapshot.location).toBe('/library/Artist/Album');
    expect(snapshot.openReview).toBeUndefined();
  });

  it('exposes the rejection outcome', () => {
    const snapshot = given([
      ...awaitingMatchReview(),
      resolved({ kind: 'reject' }),
      REJECTED,
    ]).snapshot;
    expect(snapshot.rejection).toEqual({ reason: 'gone', filesDeleted: false });
  });

  it('reports phase and terminality', () => {
    const agg = given(appliedHistory());
    expect(agg.phase).toBe('applied');
    expect(agg.isTerminal).toBe(true);
  });
});
