/**
 * Domain events — the facts that make up an import's history (event-sourcing). They narrate the
 * import *process* only: beets' library database remains the system of record for the library
 * itself, and nothing here describes library state beyond what beets reported back.
 */

/** Optional hints supplied at submission: they pin the candidate search but never the verdict. */
export interface ImportHints {
  readonly mbReleaseId?: string;
  readonly artist?: string;
  readonly album?: string;
}

/** The policy stamped onto the request: distance at or below the threshold auto-applies. */
export interface ImportPolicy {
  readonly autoApplyThreshold: number;
}

/**
 * The delivered candidate's identity as the sender published it — which peer's copy was
 * downloaded. Retained so a later release verdict can echo the identity the sender's stale-guard
 * compares against; `sizeBytes` is corroborating detail the sender may omit.
 */
export interface DeliveredCandidate {
  readonly username: string;
  readonly path: string;
  readonly sizeBytes?: number;
}

/**
 * Provenance of an event-driven submission: the sender-side acquisition that deposited the
 * directory. Recorded on `ImportRequested` so redelivered acquisition events converge durably
 * (the projection indexes it across restarts) instead of relying on in-memory dedupe. The
 * delivered candidate rides along when the event carried one — without it the import simply
 * cannot emit a release verdict.
 */
export interface ImportSource {
  readonly acquisitionId: string;
  readonly candidate?: DeliveredCandidate;
}

/**
 * A candidate's identity as beets 2.x models it: the `(data_source, album_id)` pair. Metadata
 * sources are pluggable, so a bare MusicBrainz id is ambiguous — the pair is the stable key that
 * `apply` re-resolves deterministically.
 */
export interface CandidateRef {
  readonly dataSource: string;
  readonly albumId: string;
}

export function candidateRefKey(ref: CandidateRef): string {
  return `${ref.dataSource}:${ref.albumId}`;
}

/** One component of beets' distance breakdown (e.g. `tracks`, `missing_tracks`, `year`). */
export interface CandidatePenalty {
  readonly name: string;
  readonly amount: number;
}

/** One entry of the item-to-track mapping beets computed for a candidate. */
export interface TrackMapping {
  readonly path: string;
  readonly title: string;
  readonly index: number;
}

/** A proposed candidate: identity, headline naming, and the evidence behind its distance. */
export interface ProposedCandidate {
  readonly ref: CandidateRef;
  readonly artist: string;
  readonly album: string;
  readonly distance: number;
  readonly penalties: readonly CandidatePenalty[];
  readonly tracks: readonly TrackMapping[];
}

/** An album already in the library that a candidate would duplicate. */
export interface DuplicateIncumbent {
  readonly artist: string;
  readonly album: string;
  readonly path: string;
}

/** A post-move enrichment step that failed during apply (D7: applied-with-remediation). */
export interface ApplyFailure {
  readonly stage: string;
  readonly message: string;
}

/** Why an import waits in review, with the kind-specific context a human needs to decide. */
export type ReviewCause =
  | { readonly kind: 'match-review'; readonly hinted: boolean; readonly best?: CandidateRef }
  | { readonly kind: 'no-match' }
  | {
      readonly kind: 'duplicate-review';
      readonly incumbents: readonly DuplicateIncumbent[];
    }
  | { readonly kind: 'remediation-review'; readonly failures: readonly ApplyFailure[] };

export type ReviewKind = ReviewCause['kind'];

/** Per-track fields of a manual tag payload (autotag bypassed; beets still fires plugins). */
export interface ManualTrackTags {
  readonly path: string;
  readonly title: string;
  readonly artist?: string;
  readonly trackNumber: number;
  readonly discNumber?: number;
}

/** A full manual tag payload with an explicit track mapping. */
export interface ManualTags {
  readonly albumArtist: string;
  readonly album: string;
  readonly year?: number;
  readonly tracks: readonly ManualTrackTags[];
}

/** How to settle a duplicate: replace the incumbent, or keep both. */
export type DuplicateResolution = 'replace' | 'keep-both';

/** The explicit verbs a review resolves through. */
export type Resolution =
  | {
      readonly kind: 'apply-candidate';
      readonly ref: CandidateRef;
      readonly duplicateAction?: DuplicateResolution;
    }
  | { readonly kind: 'supply-id'; readonly mbReleaseId: string }
  | { readonly kind: 'refresh-candidates' }
  | { readonly kind: 'manual-tags'; readonly tags: ManualTags }
  | { readonly kind: 'import-as-is' }
  | { readonly kind: 'reject'; readonly reason?: string }
  | { readonly kind: 'reject-and-retry-download'; readonly reasons?: readonly string[] }
  | { readonly kind: 'accept' }
  | { readonly kind: 'retry-enrichment' };

export type ResolutionKind = Resolution['kind'];

/** How beets is asked to perform an apply. */
export type ApplyMode =
  | {
      readonly kind: 'candidate';
      readonly ref: CandidateRef;
      readonly duplicateAction?: DuplicateResolution;
    }
  | { readonly kind: 'as-is' }
  | { readonly kind: 'manual-tags'; readonly tags: ManualTags };

export type ImportEvent =
  | {
      readonly type: 'ImportRequested';
      readonly directory: string;
      readonly hints?: ImportHints;
      readonly policy: ImportPolicy;
      readonly source?: ImportSource;
    }
  | {
      readonly type: 'CandidatesProposed';
      readonly candidates: readonly ProposedCandidate[];
      readonly duplicates: readonly DuplicateIncumbent[];
      readonly pinnedId?: string;
    }
  | { readonly type: 'AutoApplySelected'; readonly ref: CandidateRef; readonly distance: number }
  | { readonly type: 'ReviewRequired'; readonly cause: ReviewCause }
  | { readonly type: 'ReviewResolved'; readonly resolution: Resolution }
  | { readonly type: 'ImportApplied'; readonly location: string }
  | { readonly type: 'RemediationRequired'; readonly failures: readonly ApplyFailure[] }
  | { readonly type: 'ImportRejected'; readonly reason: string; readonly filesDeleted: boolean }
  | {
      /**
       * The delivered release failed external validation (reject-and-retry-download): the fact the
       * outbound publisher ships to the sender so it can revive the acquisition. Minted in the same
       * decision as the rejection's `ReviewResolved`; drives no effect and no state change.
       */
      readonly type: 'ReleaseVerdictRecorded';
      readonly acquisitionId: string;
      readonly candidate: DeliveredCandidate;
      readonly reasons: readonly string[];
    };

export type ImportEventType = ImportEvent['type'];
