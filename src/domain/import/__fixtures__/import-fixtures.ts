import type {
  ApplyFailure,
  DeliveredCandidate,
  DuplicateIncumbent,
  ImportEvent,
  ImportHints,
  ImportPolicy,
  ImportSource,
  ManualTags,
  ProposedCandidate,
  Resolution,
} from '../events.js';

/** Deterministic builders for domain tests. */

export const POLICY: ImportPolicy = { autoApplyThreshold: 0.1 };
export const DIRECTORY = '/intake/Artist - Album';
export const HINTS: ImportHints = { mbReleaseId: 'mb-release-1', artist: 'Artist', album: 'Album' };

export const DELIVERED_CANDIDATE: DeliveredCandidate = {
  username: 'peer1',
  path: 'peer1/Artist - Album [FLAC]',
  sizeBytes: 123_456,
};

/** Provenance of a downloader-delivered import, retained candidate included. */
export const SOURCE: ImportSource = { acquisitionId: 'acq-1', candidate: DELIVERED_CANDIDATE };

export function candidate(overrides: Partial<ProposedCandidate> = {}): ProposedCandidate {
  return {
    ref: { dataSource: 'MusicBrainz', albumId: 'album-1' },
    artist: 'Artist',
    album: 'Album',
    distance: 0.05,
    penalties: [{ name: 'tracks', amount: 0.05 }],
    tracks: [{ path: `${DIRECTORY}/01 Track.flac`, title: 'Track', index: 1 }],
    ...overrides,
  };
}

export const INCUMBENT: DuplicateIncumbent = {
  artist: 'Artist',
  album: 'Album',
  path: '/library/Artist/Album',
};

export const FAILURE: ApplyFailure = { stage: 'import-pipeline', message: 'fetchart timed out' };

export const MANUAL_TAGS: ManualTags = {
  albumArtist: 'Artist',
  album: 'Album',
  year: 2020,
  tracks: [{ path: `${DIRECTORY}/01 Track.flac`, title: 'Track', trackNumber: 1 }],
};

export function requested(
  overrides: Partial<{ hints: ImportHints; source: ImportSource }> = {},
): ImportEvent {
  return { type: 'ImportRequested', directory: DIRECTORY, policy: POLICY, ...overrides };
}

export function proposed(
  candidates: readonly ProposedCandidate[],
  duplicates: readonly DuplicateIncumbent[] = [],
  pinnedId?: string,
): ImportEvent {
  return { type: 'CandidatesProposed', candidates, duplicates, pinnedId };
}

export function resolved(resolution: Resolution): ImportEvent {
  return { type: 'ReviewResolved', resolution };
}

export const AUTO_APPLIED: ImportEvent = {
  type: 'AutoApplySelected',
  ref: { dataSource: 'MusicBrainz', albumId: 'album-1' },
  distance: 0.05,
};

export const MATCH_REVIEW: ImportEvent = {
  type: 'ReviewRequired',
  cause: {
    kind: 'match-review',
    hinted: false,
    best: { dataSource: 'MusicBrainz', albumId: 'album-1' },
  },
};

export const APPLIED: ImportEvent = { type: 'ImportApplied', location: '/library/Artist/Album' };

export const REMEDIATION: ImportEvent = { type: 'RemediationRequired', failures: [FAILURE] };

/** A history that lands in `awaiting-review` (weak match) with one listed candidate. */
export function awaitingMatchReview(): ImportEvent[] {
  return [requested(), proposed([candidate({ distance: 0.5 })]), MATCH_REVIEW];
}

/** As above, but downloader-delivered with a retained candidate (verdict-capable). */
export function awaitingReviewWithCandidate(): ImportEvent[] {
  return [requested({ source: SOURCE }), proposed([candidate({ distance: 0.5 })]), MATCH_REVIEW];
}

/** A history that auto-applied and landed `applied`. */
export function appliedHistory(): ImportEvent[] {
  return [requested(), proposed([candidate()]), AUTO_APPLIED, APPLIED];
}

/** A history that applied with a remediation review still open. */
export function remediationHistory(): ImportEvent[] {
  return [requested(), proposed([candidate()]), AUTO_APPLIED, APPLIED, REMEDIATION];
}
