import type {
  ApplyFailure,
  DuplicateIncumbent,
  ImportHints,
  ImportPolicy,
  ImportSource,
  ProposedCandidate,
  Resolution,
} from './events.js';

/**
 * Commands drive `decide`. External effect *results* re-enter as `Record*` commands so `decide`
 * acts as the single guard for stale/duplicate outcomes.
 */
export type ImportCommand =
  | {
      readonly type: 'SubmitImport';
      readonly directory: string;
      readonly hints?: ImportHints;
      readonly policy: ImportPolicy;
      readonly source?: ImportSource;
    }
  | {
      readonly type: 'RecordProposal';
      readonly candidates: readonly ProposedCandidate[];
      readonly duplicates: readonly DuplicateIncumbent[];
      readonly pinnedId?: string;
    }
  | {
      readonly type: 'RecordApplied';
      readonly location: string;
      readonly failures: readonly ApplyFailure[];
    }
  | {
      readonly type: 'RecordApplySkippedDuplicate';
      readonly incumbents: readonly DuplicateIncumbent[];
    }
  | { readonly type: 'RecordIntakeDeleted' }
  | { readonly type: 'RecordDoomed'; readonly reason: string }
  | { readonly type: 'ResolveReview'; readonly resolution: Resolution };

export type ImportCommandType = ImportCommand['type'];
