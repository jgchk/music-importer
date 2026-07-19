import type {
  ApplyFailure,
  ApplyMode,
  ImportEvent,
  ImportHints,
  ImportPolicy,
  ImportSource,
  ProposedCandidate,
  Resolution,
  ReviewCause,
} from './events.js';

/**
 * The folded state of one import (the sole aggregate), modelled as a discriminated union on
 * {@link ImportPhase} so each phase carries exactly the fields valid in it. `evolve` is a pure,
 * total fold over the event history: it never fails, performs no I/O, and ignores any event that
 * does not fit the current phase (a corrupt or externally-edited history degrades to a foldable
 * state rather than throwing). Business intelligence lives in `decide`, not here.
 */
export type ImportPhase =
  | 'empty' // no import yet
  | 'requested' // submitted; the initial proposal is in flight
  | 'proposing' // a re-proposal (supply-id / refresh) is in flight
  | 'awaiting-review' // a typed review item waits for a human
  | 'applying' // beets is applying a chosen outcome
  | 'applied' // terminal for the files; may carry an open remediation review
  | 'rejected'; // terminal

/** Facts carried by every phase past `empty`. */
interface Requested {
  readonly directory: string;
  readonly hints?: ImportHints;
  readonly policy: ImportPolicy;
  /** Provenance of an event-driven submission, incl. the retained delivered candidate (if any). */
  readonly source?: ImportSource;
}

/** The remediation review riding on an applied import (D7). */
export interface RemediationState {
  readonly failures: readonly ApplyFailure[];
  readonly status: 'open' | 'retrying';
}

export interface EmptyState {
  readonly phase: 'empty';
}
export interface RequestedState extends Requested {
  readonly phase: 'requested';
  readonly candidates: readonly ProposedCandidate[];
}
export interface ProposingState extends Requested {
  readonly phase: 'proposing';
  readonly pinnedId?: string;
  readonly candidates: readonly ProposedCandidate[];
}
export interface AwaitingReviewState extends Requested {
  readonly phase: 'awaiting-review';
  readonly cause: ReviewCause;
  readonly candidates: readonly ProposedCandidate[];
  /** Set once a resolution is recorded; further resolutions are tolerated no-ops. */
  readonly settled?: Resolution;
}
export interface ApplyingState extends Requested {
  readonly phase: 'applying';
  readonly mode: ApplyMode;
  readonly candidates: readonly ProposedCandidate[];
}
export interface AppliedState extends Requested {
  readonly phase: 'applied';
  readonly location: string;
  readonly mode: ApplyMode;
  readonly remediation?: RemediationState;
}
export interface RejectedState extends Requested {
  readonly phase: 'rejected';
  readonly reason: string;
  readonly filesDeleted: boolean;
}

export type ImportState =
  | EmptyState
  | RequestedState
  | ProposingState
  | AwaitingReviewState
  | ApplyingState
  | AppliedState
  | RejectedState;

export const initialState: EmptyState = { phase: 'empty' };

/** Terminal for the submitted files: they either entered the library or were deleted. */
export function isTerminal(state: ImportState): boolean {
  return state.phase === 'applied' || state.phase === 'rejected';
}

function requestedOf(state: Exclude<ImportState, EmptyState>): Requested {
  return {
    directory: state.directory,
    hints: state.hints,
    policy: state.policy,
    source: state.source,
  };
}

/** The apply mode a resolution implies, or undefined for the verbs that do not apply. */
function modeOfResolution(resolution: Resolution): ApplyMode | undefined {
  switch (resolution.kind) {
    case 'apply-candidate':
      return {
        kind: 'candidate',
        ref: resolution.ref,
        duplicateAction: resolution.duplicateAction,
      };
    case 'import-as-is':
      return { kind: 'as-is' };
    case 'manual-tags':
      return { kind: 'manual-tags', tags: resolution.tags };
    case 'supply-id':
    case 'refresh-candidates':
    case 'reject':
    case 'reject-and-retry-download':
    case 'accept':
    case 'retry-enrichment':
      return undefined;
  }
}

function evolveResolved(state: AwaitingReviewState, resolution: Resolution): ImportState {
  const mode = modeOfResolution(resolution);
  if (mode !== undefined) {
    return { phase: 'applying', ...requestedOf(state), mode, candidates: state.candidates };
  }
  if (resolution.kind === 'supply-id') {
    return {
      phase: 'proposing',
      ...requestedOf(state),
      pinnedId: resolution.mbReleaseId,
      candidates: state.candidates,
    };
  }
  if (resolution.kind === 'refresh-candidates') {
    return { phase: 'proposing', ...requestedOf(state), candidates: state.candidates };
  }
  // Reject / reject-and-retry-download: the review is settled; the intake deletion is still owed,
  // so the phase holds until `ImportRejected` records the outcome. (`accept`/`retry-enrichment`
  // never reach here — `decide` refuses them outside an open remediation.)
  return { ...state, settled: resolution };
}

export function evolve(state: ImportState, event: ImportEvent): ImportState {
  switch (event.type) {
    case 'ImportRequested':
      // A fresh cycle begins from nothing or from a settled terminal (the same directory can be
      // re-deposited and resubmitted after a rejection or a completed import).
      if (state.phase !== 'empty' && !isTerminal(state)) return state;
      return {
        phase: 'requested',
        directory: event.directory,
        hints: event.hints,
        policy: event.policy,
        source: event.source,
        candidates: [],
      };
    case 'CandidatesProposed':
      // The phase advances via the co-emitted `AutoApplySelected`/`ReviewRequired`; the proposed
      // list is recorded here so the following states carry it.
      if (state.phase !== 'requested' && state.phase !== 'proposing') return state;
      return { ...state, candidates: event.candidates };
    case 'AutoApplySelected':
      if (state.phase !== 'requested' && state.phase !== 'proposing') return state;
      return {
        phase: 'applying',
        ...requestedOf(state),
        mode: { kind: 'candidate', ref: event.ref },
        candidates: state.candidates,
      };
    case 'ReviewRequired':
      if (
        state.phase !== 'requested' &&
        state.phase !== 'proposing' &&
        state.phase !== 'applying'
      ) {
        return state;
      }
      return {
        phase: 'awaiting-review',
        ...requestedOf(state),
        cause: event.cause,
        candidates: state.candidates,
      };
    case 'ReviewResolved':
      if (state.phase === 'awaiting-review' && state.settled === undefined) {
        return evolveResolved(state, event.resolution);
      }
      if (state.phase === 'applied' && state.remediation?.status === 'open') {
        // Remediation verbs: accept closes the item; retry-enrichment marks the re-apply in flight.
        return event.resolution.kind === 'retry-enrichment'
          ? { ...state, remediation: { failures: state.remediation.failures, status: 'retrying' } }
          : { ...state, remediation: undefined };
      }
      return state;
    case 'ImportApplied':
      if (state.phase === 'applying') {
        return {
          phase: 'applied',
          ...requestedOf(state),
          location: event.location,
          mode: state.mode,
        };
      }
      // A retried enrichment re-applied: refresh the location and clear the remediation.
      if (state.phase === 'applied') {
        return { ...state, location: event.location, remediation: undefined };
      }
      return state;
    case 'RemediationRequired':
      if (state.phase !== 'applied') return state;
      return { ...state, remediation: { failures: event.failures, status: 'open' } };
    case 'ImportRejected':
      if (state.phase === 'empty' || isTerminal(state)) return state;
      return {
        phase: 'rejected',
        ...requestedOf(state),
        reason: event.reason,
        filesDeleted: event.filesDeleted,
      };
    case 'ReleaseVerdictRecorded':
      // A record-only fact for the outbound publisher: it changes no import state.
      return state;
  }
}

/** Fold a whole history into state — the replay path and a convenient test builder. */
export function foldEvents(events: readonly ImportEvent[]): ImportState {
  return events.reduce(evolve, initialState);
}
