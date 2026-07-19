import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { ImportCommand } from './commands.js';
import { candidateRefKey } from './events.js';
import type { DuplicateIncumbent, ImportEvent, ProposedCandidate, Resolution } from './events.js';
import { isTerminal } from './state.js';
import type { AppliedState, AwaitingReviewState, ImportState } from './state.js';

/**
 * Protocol violations a caller can commit — the `Err` channel of `decide`. Stale or duplicate
 * *outcomes* (an effect result arriving after the stream moved on, a redelivered resolution of a
 * settled review) are not errors: they converge as an empty event list.
 */
export type DomainError =
  | { readonly kind: 'UnknownImport' }
  | { readonly kind: 'NoOpenReview' }
  | { readonly kind: 'InvalidResolution'; readonly detail: string }
  | { readonly kind: 'UnknownCandidate'; readonly candidate: string }
  /** reject-and-retry-download needs a retained delivered candidate; this import has none. */
  | { readonly kind: 'NoRetainedCandidate' };

type Decision = Result<readonly ImportEvent[], DomainError>;

const NOTHING: Decision = ok([]);

/** The lowest-distance candidate — beets' ordering, re-derived so `decide` never trusts input order. */
function bestOf(candidates: readonly ProposedCandidate[]): ProposedCandidate {
  return candidates.reduce((best, next) => (next.distance < best.distance ? next : best));
}

function decideProposal(
  state: ImportState,
  candidates: readonly ProposedCandidate[],
  duplicates: readonly DuplicateIncumbent[],
  pinnedId: string | undefined,
): Decision {
  if (state.phase !== 'requested' && state.phase !== 'proposing') return NOTHING; // stale outcome
  const proposed: ImportEvent = { type: 'CandidatesProposed', candidates, duplicates, pinnedId };
  if (candidates.length === 0) {
    return ok([proposed, { type: 'ReviewRequired', cause: { kind: 'no-match' } }]);
  }
  const best = bestOf(candidates);
  const hinted =
    pinnedId !== undefined ||
    (state.phase === 'proposing' && state.pinnedId !== undefined) ||
    state.hints?.mbReleaseId !== undefined;
  if (best.distance > state.policy.autoApplyThreshold) {
    // A weak — or hint-contradicted — match goes to a human with the evidence (D4): the candidate
    // list rides on `CandidatesProposed`, the mismatch detail on the best candidate's penalties.
    return ok([
      proposed,
      { type: 'ReviewRequired', cause: { kind: 'match-review', hinted, best: best.ref } },
    ]);
  }
  if (duplicates.length > 0) {
    // Strong match, but the library already has it: never auto-replace in this change (D5).
    return ok([
      proposed,
      { type: 'ReviewRequired', cause: { kind: 'duplicate-review', incumbents: duplicates } },
    ]);
  }
  return ok([proposed, { type: 'AutoApplySelected', ref: best.ref, distance: best.distance }]);
}

function decideResolutionForReview(state: AwaitingReviewState, resolution: Resolution): Decision {
  if (state.settled !== undefined) return NOTHING; // redelivered resolution converges
  if (resolution.kind === 'accept' || resolution.kind === 'retry-enrichment') {
    return err({
      kind: 'InvalidResolution',
      detail: `${resolution.kind} resolves a remediation review, not a ${state.cause.kind}`,
    });
  }
  if (resolution.kind === 'apply-candidate') {
    const known = state.candidates.some(
      (candidate) => candidateRefKey(candidate.ref) === candidateRefKey(resolution.ref),
    );
    if (!known)
      return err({ kind: 'UnknownCandidate', candidate: candidateRefKey(resolution.ref) });
  }
  if (resolution.kind === 'reject-and-retry-download') {
    // The verdict must echo the identity the sender fulfilled with (its stale-guard compares it);
    // without a retained candidate the verb is refused precisely — plain reject stays available.
    const source = state.source;
    if (source?.candidate === undefined) return err({ kind: 'NoRetainedCandidate' });
    return ok([
      { type: 'ReviewResolved', resolution },
      {
        type: 'ReleaseVerdictRecorded',
        acquisitionId: source.acquisitionId,
        candidate: source.candidate,
        reasons: resolution.reasons ?? [],
      },
    ]);
  }
  return ok([{ type: 'ReviewResolved', resolution }]);
}

function decideResolutionForApplied(state: AppliedState, resolution: Resolution): Decision {
  if (state.remediation === undefined || state.remediation.status !== 'open') return NOTHING;
  if (resolution.kind !== 'accept' && resolution.kind !== 'retry-enrichment') {
    return err({
      kind: 'InvalidResolution',
      detail: `a remediation review resolves through accept or retry-enrichment, not ${resolution.kind}`,
    });
  }
  return ok([{ type: 'ReviewResolved', resolution }]);
}

function decideResolution(state: ImportState, resolution: Resolution): Decision {
  switch (state.phase) {
    case 'empty':
      return err({ kind: 'UnknownImport' });
    case 'requested':
      return err({ kind: 'NoOpenReview' });
    case 'awaiting-review':
      return decideResolutionForReview(state, resolution);
    case 'applied':
      return decideResolutionForApplied(state, resolution);
    // A resolution already in motion (re-proposing, applying) or a settled rejection: converge.
    case 'proposing':
    case 'applying':
    case 'rejected':
      return NOTHING;
  }
}

/**
 * The single decision point: a command against the folded state yields the events to append, an
 * empty list for a stale/duplicate outcome, or a `DomainError` for a protocol violation.
 */
export function decide(command: ImportCommand, state: ImportState): Decision {
  switch (command.type) {
    case 'SubmitImport':
      // Idempotent by stream: a live import converges on itself; a settled terminal starts a
      // fresh cycle for the re-deposited directory.
      if (state.phase !== 'empty' && !isTerminal(state)) return NOTHING;
      return ok([
        {
          type: 'ImportRequested',
          directory: command.directory,
          hints: command.hints,
          policy: command.policy,
          source: command.source,
        },
      ]);
    case 'RecordProposal':
      return decideProposal(state, command.candidates, command.duplicates, command.pinnedId);
    case 'RecordApplied': {
      const retrying = state.phase === 'applied' && state.remediation?.status === 'retrying';
      if (state.phase !== 'applying' && !retrying) return NOTHING; // stale outcome
      const applied: ImportEvent = { type: 'ImportApplied', location: command.location };
      return command.failures.length === 0
        ? ok([applied])
        : ok([applied, { type: 'RemediationRequired', failures: command.failures }]);
    }
    case 'RecordApplySkippedDuplicate':
      // Beets refused to import over an incumbent it only saw at apply time: route to review.
      if (state.phase !== 'applying') return NOTHING;
      return ok([
        {
          type: 'ReviewRequired',
          cause: { kind: 'duplicate-review', incumbents: command.incumbents },
        },
      ]);
    case 'RecordIntakeDeleted': {
      if (state.phase !== 'awaiting-review') return NOTHING;
      const settled = state.settled;
      if (settled?.kind === 'reject') {
        const reason = settled.reason ?? 'rejected by review';
        return ok([{ type: 'ImportRejected', reason, filesDeleted: true }]);
      }
      if (settled?.kind === 'reject-and-retry-download') {
        const reasons = settled.reasons ?? [];
        const reason = reasons.length > 0 ? reasons.join('; ') : 'rejected by review';
        return ok([{ type: 'ImportRejected', reason, filesDeleted: true }]);
      }
      return NOTHING;
    }
    case 'RecordDoomed':
      // A permanent effect failure dooms the import (D7): terminal `rejected`, files untouched.
      if (state.phase === 'empty' || isTerminal(state)) return NOTHING;
      return ok([{ type: 'ImportRejected', reason: command.reason, filesDeleted: false }]);
    case 'ResolveReview':
      return decideResolution(state, command.resolution);
  }
}
