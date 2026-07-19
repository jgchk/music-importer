import type { ApplyMode, ImportEvent } from './events.js';
import type { ImportState } from './state.js';

/**
 * `react` is the reflex: a pure, trivial map from an event to zero or more `Effect`
 * *descriptions*. It makes no decisions and performs no I/O — the imperative shell interprets
 * each Effect by calling a port and feeds the result back through `decide` as a command.
 */
export type Effect =
  | {
      readonly type: 'Propose';
      readonly directory: string;
      readonly searchId?: string;
      readonly searchArtist?: string;
      readonly searchAlbum?: string;
    }
  | { readonly type: 'Apply'; readonly directory: string; readonly mode: ApplyMode }
  | { readonly type: 'DeleteIntake'; readonly directory: string };

/**
 * `state` is the state *as of* `event`: the fold of the stream prefix up to and including it (the
 * reactor slices the stream before reacting). The phase narrowings below are refinements over the
 * state union; for a well-formed history each guard's phase is implied by the event just folded,
 * and a pairing that does not match falls through to no effects — consistent with `evolve`'s
 * tolerant fold. Re-firing under redelivery is safe by contract, not by suppression here: effects
 * are idempotent at the port and their follow-on commands pass back through `decide`, which
 * rejects stale outcomes.
 */
export function react(event: ImportEvent, state: ImportState): readonly Effect[] {
  switch (event.type) {
    case 'ImportRequested':
      return [
        {
          type: 'Propose',
          directory: event.directory,
          searchId: event.hints?.mbReleaseId,
          searchArtist: event.hints?.artist,
          searchAlbum: event.hints?.album,
        },
      ];
    case 'AutoApplySelected':
      return state.phase === 'applying'
        ? [{ type: 'Apply', directory: state.directory, mode: state.mode }]
        : [];
    case 'ReviewResolved':
      switch (event.resolution.kind) {
        case 'apply-candidate':
        case 'import-as-is':
        case 'manual-tags':
          return state.phase === 'applying'
            ? [{ type: 'Apply', directory: state.directory, mode: state.mode }]
            : [];
        case 'supply-id':
          return state.phase === 'proposing'
            ? [
                {
                  type: 'Propose',
                  directory: state.directory,
                  searchId: event.resolution.mbReleaseId,
                },
              ]
            : [];
        case 'refresh-candidates':
          return state.phase === 'proposing'
            ? [{ type: 'Propose', directory: state.directory }]
            : [];
        case 'reject':
        case 'reject-and-retry-download':
          // Both rejection verbs owe the same intake hygiene; the verdict itself is a record-only
          // fact the outbound publisher consumes, never an effect here.
          return state.phase === 'awaiting-review'
            ? [{ type: 'DeleteIntake', directory: state.directory }]
            : [];
        case 'retry-enrichment':
          // Re-run beets over the already-imported location: a deterministic in-place re-import
          // that re-fires the full plugin chain against files beets already owns.
          return state.phase === 'applied' && state.remediation?.status === 'retrying'
            ? [{ type: 'Apply', directory: state.location, mode: state.mode }]
            : [];
        case 'accept':
          return [];
      }

    case 'CandidatesProposed':
    case 'ReviewRequired':
    case 'ImportApplied':
    case 'RemediationRequired':
    case 'ImportRejected':
    case 'ReleaseVerdictRecorded':
      return [];
  }
}
