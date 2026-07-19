import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import type { StoredEvent } from '../../../application/ports/event-store-port.js';
import type {
  PublishedEvent,
  PublishedEventMapping,
  RenderError,
} from '../../../application/ports/published-events-port.js';
import { RELEASE_VERDICT_TYPE, releaseVerdictEventSchema } from './schemas.js';

/**
 * Renders `release.verdict` from a stored `ReleaseVerdictRecorded` (change:
 * outbound-release-verdicts). The domain event is minted self-contained — acquisition id,
 * candidate identity, reasons — so rendering needs no prefix fold; the prefix parameter stays in
 * the signature for parity with the port (future event types may assemble from the stream). The
 * result is validated against the outbound schema; a violating payload never leaves the process.
 */

function renderError(message: string): RenderError {
  return { kind: 'RenderError', eventType: RELEASE_VERDICT_TYPE, message };
}

function renderVerdict(
  stored: StoredEvent,
  _prefix: readonly StoredEvent[],
): Result<PublishedEvent, RenderError> {
  if (stored.event.type !== 'ReleaseVerdictRecorded') {
    return err(renderError(`event type ${stored.event.type} has no published mapping`));
  }
  const { acquisitionId, candidate, reasons } = stored.event;
  const envelope = {
    type: RELEASE_VERDICT_TYPE,
    timestamp: stored.metadata.occurredAt,
    data: {
      acquisitionId,
      candidate: {
        username: candidate.username,
        path: candidate.path,
        // Omitted — never null — when unknown: the receiver reads an optional number.
        ...(candidate.sizeBytes === undefined ? {} : { sizeBytes: candidate.sizeBytes }),
      },
      verdict: 'rejected',
      reasons: [...reasons],
    },
  };
  const parsed = releaseVerdictEventSchema.safeParse(envelope);
  return parsed.success
    ? ok(parsed.data)
    : err(renderError(`rendered payload violates the outbound schema: ${parsed.error.message}`));
}

/** The catalog of published event types — additive: future types join here. */
export const publishedEventMapping: PublishedEventMapping = {
  publishes: (type) => type === 'ReleaseVerdictRecorded',
  render: renderVerdict,
};
