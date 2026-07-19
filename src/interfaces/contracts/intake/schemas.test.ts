import { describe, expect, it } from 'vitest';
import { acquisitionFulfilledSchema, intakeEventEnvelopeSchema } from './schemas.js';

/** A representative sender payload, including fields the importer deliberately does not read. */
function fulfilledPayload(): Record<string, unknown> {
  return {
    type: 'acquisition.fulfilled',
    timestamp: '2026-07-19T12:00:00.000Z',
    data: {
      acquisitionId: 'acq-1',
      target: {
        type: 'album',
        artist: 'Radiohead',
        title: 'Kid A',
        musicbrainzReleaseId: 'mb-release-1',
        year: 2000,
        trackCount: 2,
      },
      candidate: { username: 'peer1', path: 'peer1/x', sizeBytes: 1000 },
      location: '/downloads/import/Radiohead - Kid A',
      files: [{ name: '01.flac', path: '/downloads/import/Radiohead - Kid A/01.flac' }],
    },
  };
}

describe('intakeEventEnvelopeSchema', () => {
  it('reads the type and nothing else', () => {
    expect(intakeEventEnvelopeSchema.parse(fulfilledPayload())).toEqual({
      type: 'acquisition.fulfilled',
    });
  });

  it('rejects an envelope without a type', () => {
    expect(intakeEventEnvelopeSchema.safeParse({ data: {} }).success).toBe(false);
  });
});

describe('acquisitionFulfilledSchema — the tolerant reader', () => {
  it('accepts the full sender payload and keeps only the consumed fields', () => {
    const parsed = acquisitionFulfilledSchema.parse(fulfilledPayload());
    expect(parsed).toEqual({
      type: 'acquisition.fulfilled',
      data: {
        acquisitionId: 'acq-1',
        location: '/downloads/import/Radiohead - Kid A',
        target: {
          type: 'album',
          artist: 'Radiohead',
          title: 'Kid A',
          musicbrainzReleaseId: 'mb-release-1',
        },
        candidate: { username: 'peer1', path: 'peer1/x', sizeBytes: 1000 },
      },
    });
  });

  it('tolerates unknown fields at every level and unknown target types', () => {
    const payload = fulfilledPayload();
    Object.assign(payload, { futureEnvelopeField: true });
    const data = payload['data'] as Record<string, unknown>;
    Object.assign(data, { futureDataField: { nested: 1 } });
    Object.assign(data['target'] as Record<string, unknown>, {
      type: 'boxset',
      futureTargetField: 'x',
    });
    const parsed = acquisitionFulfilledSchema.parse(payload);
    expect(parsed.data.target.type).toBe('boxset');
  });

  it('tolerates a null or absent MusicBrainz release id', () => {
    const nulled = fulfilledPayload();
    ((nulled['data'] as Record<string, unknown>)['target'] as Record<string, unknown>)[
      'musicbrainzReleaseId'
    ] = null;
    expect(acquisitionFulfilledSchema.parse(nulled).data.target.musicbrainzReleaseId).toBeNull();

    const absent = fulfilledPayload();
    delete ((absent['data'] as Record<string, unknown>)['target'] as Record<string, unknown>)[
      'musicbrainzReleaseId'
    ];
    expect(
      acquisitionFulfilledSchema.parse(absent).data.target.musicbrainzReleaseId,
    ).toBeUndefined();
  });

  it('tolerates an absent, size-less, or malformed candidate (only verdicts need it)', () => {
    const absent = fulfilledPayload();
    delete (absent['data'] as Record<string, unknown>)['candidate'];
    expect(acquisitionFulfilledSchema.parse(absent).data.candidate).toBeUndefined();

    const sizeless = fulfilledPayload();
    delete ((sizeless['data'] as Record<string, unknown>)['candidate'] as Record<string, unknown>)[
      'sizeBytes'
    ];
    expect(acquisitionFulfilledSchema.parse(sizeless).data.candidate).toEqual({
      username: 'peer1',
      path: 'peer1/x',
    });

    const malformed = fulfilledPayload();
    (malformed['data'] as Record<string, unknown>)['candidate'] = { username: 42 };
    expect(acquisitionFulfilledSchema.parse(malformed).data.candidate).toBeUndefined();
  });

  it('rejects a payload missing the fields the importer actually needs', () => {
    for (const strip of ['acquisitionId', 'location', 'target'] as const) {
      const payload = fulfilledPayload();
      delete (payload['data'] as Record<string, unknown>)[strip];
      expect(acquisitionFulfilledSchema.safeParse(payload).success).toBe(false);
    }
  });
});
