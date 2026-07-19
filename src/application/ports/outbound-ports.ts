import type { ResultAsync } from 'neverthrow';
import type {
  ApplyFailure,
  ApplyMode,
  DuplicateIncumbent,
  ProposedCandidate,
} from '../../domain/import/events.js';
import type { InfraError } from './errors.js';

/**
 * Outbound ports (hexagonal): the application's view of the world. Adapters implement these and
 * translate raw wire/tool payloads into the domain vocabulary (anti-corruption). Business sadness
 * (no candidates, a doomed directory, a duplicate skip) travels in the `Ok` channel as data;
 * `InfraError` is reserved for faults worth retrying (spawn failures, timeouts, contract drift).
 */

/** What to pin a proposal's candidate search to (hints aid matching, never override it — D4). */
export interface ProposePins {
  readonly searchId?: string;
  readonly searchArtist?: string;
  readonly searchAlbum?: string;
}

/** The outcome of a propose: candidates plus any library incumbents, or a permanent refusal. */
export type ProposeOutcome =
  | {
      readonly kind: 'proposal';
      readonly candidates: readonly ProposedCandidate[];
      readonly duplicates: readonly DuplicateIncumbent[];
    }
  | { readonly kind: 'doomed'; readonly reason: string };

/** The outcome of an apply: files landed (with any enrichment failures), a duplicate skip, or a permanent refusal. */
export type ApplyOutcome =
  | {
      readonly kind: 'applied';
      readonly location: string;
      readonly failures: readonly ApplyFailure[];
    }
  | { readonly kind: 'skipped-duplicate'; readonly incumbents: readonly DuplicateIncumbent[] }
  | { readonly kind: 'doomed'; readonly reason: string };

/** The effective beets configuration, as validated and reported by the bridge at startup. */
export interface TaggerConfiguration {
  readonly beetsVersion: string;
  readonly libraryDatabase: string;
  readonly libraryDirectory: string;
  readonly plugins: readonly string[];
  readonly overlay: Readonly<Record<string, unknown>>;
}

/**
 * The tagging/import engine behind a port (D2): beets, driven through the stateless two-phase
 * bridge. Implementations MUST serialize invocations — beets' SQLite tolerates one writer.
 */
export interface TaggerPort {
  /** Run beets' matcher over a directory, optionally pinned by hints. */
  propose(directory: string, pins: ProposePins): ResultAsync<ProposeOutcome, InfraError>;

  /** Perform the import for a chosen outcome, firing beets' full pipeline. */
  apply(directory: string, mode: ApplyMode): ResultAsync<ApplyOutcome, InfraError>;

  /** Validate the beets configuration and report the effective merged view (startup gate). */
  validate(): ResultAsync<TaggerConfiguration, InfraError>;
}

/** Intake-directory stewardship: the only filesystem writes this service performs itself (D5). */
export interface IntakePort {
  /** Delete a rejected release's directory from intake, tolerating an already-gone one. */
  deleteRelease(directory: string): ResultAsync<void, InfraError>;
}
