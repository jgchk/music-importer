import { describe, expect, it } from 'vitest';
import {
  RELEASE_VERDICT_TYPE,
  releaseVerdictDataSchema,
  releaseVerdictEventSchema,
} from './schemas.js';

const data = {
  acquisitionId: 'acq-1',
  candidate: { username: 'peer1', path: 'peer1/Artist - Album [FLAC]', sizeBytes: 123_456 },
  verdict: 'rejected',
  reasons: ['corrupt rip', 'transcode'],
};

const envelope = {
  type: 'release.verdict',
  timestamp: '2026-07-18T12:00:00.000Z',
  data,
};

describe('releaseVerdictDataSchema', () => {
  it('accepts a complete payload and round-trips it unchanged', () => {
    expect(releaseVerdictDataSchema.parse(data)).toEqual(data);
  });

  it('accepts a candidate without sizeBytes (omitted, never null — the receiver reads an optional number)', () => {
    const { sizeBytes: _size, ...bareCandidate } = data.candidate;
    const parsed = releaseVerdictDataSchema.parse({ ...data, candidate: bareCandidate });
    expect(parsed.candidate).toEqual(bareCandidate);
    expect('sizeBytes' in parsed.candidate).toBe(false);
  });

  it('accepts an empty reasons list but not an absent one', () => {
    expect(releaseVerdictDataSchema.parse({ ...data, reasons: [] }).reasons).toEqual([]);
    const { reasons: _reasons, ...rest } = data;
    expect(releaseVerdictDataSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a payload missing its acquisition id or candidate', () => {
    const { acquisitionId: _id, ...noId } = data;
    expect(releaseVerdictDataSchema.safeParse(noId).success).toBe(false);
    const { candidate: _candidate, ...noCandidate } = data;
    expect(releaseVerdictDataSchema.safeParse(noCandidate).success).toBe(false);
  });

  it('rejects an unknown verdict value (accepting more verdicts later is additive)', () => {
    expect(releaseVerdictDataSchema.safeParse({ ...data, verdict: 'accepted' }).success).toBe(
      false,
    );
  });
});

describe('releaseVerdictEventSchema', () => {
  it('accepts the {type, timestamp, data} envelope', () => {
    const parsed = releaseVerdictEventSchema.parse(envelope);
    expect(parsed.type).toBe(RELEASE_VERDICT_TYPE);
    expect(parsed.timestamp).toBe('2026-07-18T12:00:00.000Z');
    expect(parsed.data).toEqual(data);
  });

  it('rejects a foreign event type literal', () => {
    expect(releaseVerdictEventSchema.safeParse({ ...envelope, type: 'other.event' }).success).toBe(
      false,
    );
  });

  it('rejects a non-ISO-8601 timestamp', () => {
    expect(releaseVerdictEventSchema.safeParse({ ...envelope, timestamp: 'today' }).success).toBe(
      false,
    );
  });
});
