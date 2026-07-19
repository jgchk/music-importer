import type { Result } from 'neverthrow';
import type { ImportCommand } from './commands.js';
import { decide } from './decide.js';
import type { DomainError } from './decide.js';
import type { ImportEvent, ProposedCandidate, ReviewCause } from './events.js';
import { react } from './react.js';
import type { Effect } from './react.js';
import { foldEvents, isTerminal } from './state.js';
import type { ImportPhase, ImportState } from './state.js';

/**
 * The import aggregate: the single public face of the import domain. It wraps the functional
 * decider — `decide`/`evolve`/`react` and the folded `ImportState` stay private module internals
 * of this folder, reachable only through this class. The aggregate is pure and immutable:
 * rehydrate a history with {@link Import.fromHistory}, then observe it — nothing here performs
 * I/O or mutates.
 *
 * Commands, events, {@link DomainError}, {@link Effect}, and {@link ImportPhase} remain the
 * public contract (the wire format of the decide/react loop); the write-model state shape and the
 * decision logic are the secrets.
 */
export type { DomainError } from './decide.js';
export type { Effect } from './react.js';
export type { ImportPhase } from './state.js';

/** The open review riding on this import, if any — what the pending-reviews queue projects. */
export interface OpenReview {
  readonly cause: ReviewCause;
  readonly candidates: readonly ProposedCandidate[];
}

/**
 * A read projection of the folded state — the observable facts a query model needs, all of which
 * are already part of the public import-status contract. Distinct from the private write-model
 * `ImportState`, which the aggregate never exposes.
 */
export interface ImportSnapshot {
  readonly phase: ImportPhase;
  readonly directory?: string;
  readonly location?: string;
  readonly openReview?: OpenReview;
  readonly rejection?: { readonly reason: string; readonly filesDeleted: boolean };
}

function openReviewOf(state: ImportState): OpenReview | undefined {
  if (state.phase === 'awaiting-review' && state.settled === undefined) {
    return { cause: state.cause, candidates: state.candidates };
  }
  if (state.phase === 'applied' && state.remediation?.status === 'open') {
    return {
      cause: { kind: 'remediation-review', failures: state.remediation.failures },
      candidates: [],
    };
  }
  return undefined;
}

export class Import {
  private constructor(private readonly state: ImportState) {}

  /** Rehydrate an aggregate by folding its event history (the replay path). */
  static fromHistory(events: readonly ImportEvent[]): Import {
    return new Import(foldEvents(events));
  }

  /** Run a command against the current state: the events to append, or a `DomainError`. */
  execute(command: ImportCommand): Result<readonly ImportEvent[], DomainError> {
    return decide(command, this.state);
  }

  /** The reflex: zero or more effect descriptions for an event applied to this state. */
  reactTo(event: ImportEvent): readonly Effect[] {
    return react(event, this.state);
  }

  get phase(): ImportPhase {
    return this.state.phase;
  }

  get isTerminal(): boolean {
    return isTerminal(this.state);
  }

  /** The read-model projection of this aggregate's folded state. */
  get snapshot(): ImportSnapshot {
    const state = this.state;
    return {
      phase: state.phase,
      directory: 'directory' in state ? state.directory : undefined,
      location: state.phase === 'applied' ? state.location : undefined,
      openReview: openReviewOf(state),
      rejection:
        state.phase === 'rejected'
          ? { reason: state.reason, filesDeleted: state.filesDeleted }
          : undefined,
    };
  }
}
