import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../../../application/ports/event-store-port.js';
import type { ImportEvent } from '../../../domain/import/events.js';
import {
  DELIVERED_CANDIDATE,
  SOURCE,
  awaitingReviewWithCandidate,
  resolved,
} from '../../../domain/import/__fixtures__/import-fixtures.js';
import { publishedEventMapping } from './mapping.js';

const OCCURRED_AT = '2026-07-18T12:00:00.000Z';

function stored(events: readonly ImportEvent[], streamId = 'imp-1'): StoredEvent[] {
  return events.map((event, index) => ({
    globalSeq: index + 1,
    streamId,
    version: index,
    type: event.type,
    event,
    metadata: { importId: streamId, occurredAt: OCCURRED_AT },
  }));
}

function verdictHistory(
  overrides: Partial<Extract<ImportEvent, { type: 'ReleaseVerdictRecorded' }>> = {},
): ImportEvent[] {
  return [
    ...awaitingReviewWithCandidate(),
    resolved({ kind: 'reject-and-retry-download', reasons: ['corrupt rip'] }),
    {
      type: 'ReleaseVerdictRecorded',
      acquisitionId: SOURCE.acquisitionId,
      candidate: DELIVERED_CANDIDATE,
      reasons: ['corrupt rip'],
      ...overrides,
    },
  ];
}

function renderLast(events: readonly ImportEvent[]) {
  const prefix = stored(events);
  return publishedEventMapping.render(prefix.at(-1)!, prefix);
}

describe('publishedEventMapping.publishes', () => {
  it('maps ReleaseVerdictRecorded and nothing else', () => {
    expect(publishedEventMapping.publishes('ReleaseVerdictRecorded')).toBe(true);
    expect(publishedEventMapping.publishes('ImportRequested')).toBe(false);
    expect(publishedEventMapping.publishes('ImportRejected')).toBe(false);
  });
});

describe('publishedEventMapping.render — release.verdict', () => {
  it('renders the self-contained payload from the recorded verdict', () => {
    const rendered = renderLast(verdictHistory())._unsafeUnwrap();

    expect(rendered.type).toBe('release.verdict');
    expect(rendered.timestamp).toBe(OCCURRED_AT);
    expect(rendered.data).toEqual({
      acquisitionId: 'acq-1',
      candidate: DELIVERED_CANDIDATE,
      verdict: 'rejected',
      reasons: ['corrupt rip'],
    });
  });

  it('omits sizeBytes — never null — when the retained candidate has none', () => {
    const { sizeBytes: _size, ...bareCandidate } = DELIVERED_CANDIDATE;
    const rendered = renderLast(verdictHistory({ candidate: bareCandidate }))._unsafeUnwrap();
    const data = rendered.data as { candidate: Record<string, unknown> };
    expect(data.candidate).toEqual(bareCandidate);
    expect('sizeBytes' in data.candidate).toBe(false);
  });

  it('refuses an event type without a published mapping', () => {
    const prefix = stored(verdictHistory().slice(0, 1));
    const error = publishedEventMapping.render(prefix[0]!, prefix)._unsafeUnwrapErr();
    expect(error.kind).toBe('RenderError');
    expect(error.message).toContain('no published mapping');
  });

  it('refuses a payload that violates the outbound schema (it must never leave the process)', () => {
    const error = renderLast(verdictHistory({ acquisitionId: '' }))._unsafeUnwrapErr();
    expect(error.kind).toBe('RenderError');
    expect(error.message).toContain('schema');
  });
});
