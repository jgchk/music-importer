import { createHash } from 'node:crypto';
import type { ResultAsync } from 'neverthrow';
import type {
  ImportHints,
  ImportPolicy,
  ImportSource,
  Resolution,
} from '../../domain/import/events.js';
import type {
  ImportStatusProjection,
  ImportStatusView,
  PendingReviewView,
} from '../projections/read-models.js';
import { applyCommand } from './command-handler.js';
import type { CommandDeps, CommandError } from './command-handler.js';

/**
 * The application use-cases: the real, stable API the interfaces (HTTP, MCP) map onto. Commands
 * are async submit-and-observe; queries read the projection synchronously. An import is keyed by
 * its directory (D5): the stream id is derived from the normalized path, which is what makes
 * resubmission idempotent — the same directory always converges on the same stream.
 */
export interface UseCaseDeps extends CommandDeps {
  readonly status: ImportStatusProjection;
  readonly policy: ImportPolicy;
}

/** Normalize a submitted path (collapse trailing slashes) so cosmetic variants share a stream. */
function normalizeDirectory(directory: string): string {
  const trimmed = directory.replace(/\/+$/u, '');
  return trimmed === '' ? '/' : trimmed;
}

/** The deterministic stream id for a directory: stable, URL-safe, collision-resistant. */
export function importIdFor(directory: string): string {
  const digest = createHash('sha256').update(normalizeDirectory(directory)).digest('hex');
  return `imp-${digest.slice(0, 24)}`;
}

export interface SubmitImportInput {
  readonly directory: string;
  readonly hints?: ImportHints;
  /** Provenance of an event-driven submission, recorded for durable acquisition idempotency. */
  readonly source?: ImportSource;
}

export function submitImport(
  deps: UseCaseDeps,
  input: SubmitImportInput,
): ResultAsync<{ readonly importId: string }, CommandError> {
  const directory = normalizeDirectory(input.directory);
  const importId = importIdFor(directory);
  return applyCommand(deps, importId, {
    type: 'SubmitImport',
    directory,
    hints: input.hints,
    policy: deps.policy,
    source: input.source,
  }).map(() => ({ importId }));
}

/** The import an acquisition already submitted, if any — the webhook receiver's convergence check. */
export function findAcquisitionImport(
  deps: UseCaseDeps,
  acquisitionId: string,
): string | undefined {
  return deps.status.importIdForAcquisition(acquisitionId);
}

export function resolveReview(
  deps: UseCaseDeps,
  importId: string,
  resolution: Resolution,
): ResultAsync<void, CommandError> {
  return applyCommand(deps, importId, { type: 'ResolveReview', resolution }).map(() => undefined);
}

export function getImport(deps: UseCaseDeps, importId: string): ImportStatusView | undefined {
  return deps.status.get(importId);
}

export function listImports(deps: UseCaseDeps): readonly ImportStatusView[] {
  return deps.status.list();
}

export function listPendingReviews(deps: UseCaseDeps): readonly PendingReviewView[] {
  return deps.status.pendingReviews();
}
