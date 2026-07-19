import { describe, expect, it } from 'vitest';
import {
  importStatusResponseSchema,
  pendingReviewSchema,
  resolveReviewRequestSchema,
  submitImportRequestSchema,
} from './schemas.js';

/**
 * Round-trip checks over the wire contracts: representative valid payloads parse unchanged, and
 * the malformed shapes the API must refuse are refused by schema, not by handler code.
 */

describe('submitImportRequestSchema', () => {
  it('accepts a path with optional hints', () => {
    const payload = {
      path: '/intake/Artist - Album',
      hints: { mbReleaseId: 'mb-1', artist: 'Artist', album: 'Album' },
    };
    expect(submitImportRequestSchema.parse(payload)).toEqual(payload);
  });

  it('refuses a missing or empty path', () => {
    expect(submitImportRequestSchema.safeParse({}).success).toBe(false);
    expect(submitImportRequestSchema.safeParse({ path: '' }).success).toBe(false);
  });
});

describe('resolveReviewRequestSchema', () => {
  it.each([
    [{ verb: 'apply-candidate', candidate: { dataSource: 'MusicBrainz', albumId: 'a1' } }],
    [
      {
        verb: 'apply-candidate',
        candidate: { dataSource: 'MusicBrainz', albumId: 'a1' },
        duplicateAction: 'replace',
      },
    ],
    [{ verb: 'supply-id', mbReleaseId: 'mb-2' }],
    [{ verb: 'refresh-candidates' }],
    [
      {
        verb: 'manual-tags',
        tags: {
          albumArtist: 'A',
          album: 'B',
          year: 2021,
          tracks: [{ path: 'a.mp3', title: 'T', trackNumber: 1, discNumber: 1, artist: 'A' }],
        },
      },
    ],
    [{ verb: 'import-as-is' }],
    [{ verb: 'reject', reason: 'wrong rip' }],
    [{ verb: 'reject-and-retry-download', reasons: ['corrupt rip', 'transcode'] }],
    [{ verb: 'reject-and-retry-download' }],
    [{ verb: 'accept' }],
    [{ verb: 'retry-enrichment' }],
  ])('accepts %j', (payload) => {
    expect(resolveReviewRequestSchema.parse(payload)).toEqual(payload);
  });

  it('refuses an unknown verb, a ref-less apply, and an empty manual payload', () => {
    expect(resolveReviewRequestSchema.safeParse({ verb: 'zap' }).success).toBe(false);
    expect(resolveReviewRequestSchema.safeParse({ verb: 'apply-candidate' }).success).toBe(false);
    expect(
      resolveReviewRequestSchema.safeParse({
        verb: 'manual-tags',
        tags: { albumArtist: 'A', album: 'B', tracks: [] },
      }).success,
    ).toBe(false);
  });

  it('refuses an empty reason string on the retry verb (omit it instead)', () => {
    expect(
      resolveReviewRequestSchema.safeParse({ verb: 'reject-and-retry-download', reasons: [''] })
        .success,
    ).toBe(false);
  });
});

describe('response schemas', () => {
  it('round-trips a full status view', () => {
    const payload = {
      importId: 'imp-1',
      path: '/intake/a',
      status: 'awaiting-review',
      review: {
        kind: 'match-review',
        hinted: true,
        best: { dataSource: 'MusicBrainz', albumId: 'a1' },
        candidates: [
          {
            ref: { dataSource: 'MusicBrainz', albumId: 'a1' },
            artist: 'A',
            album: 'B',
            distance: 0.4,
            penalties: [{ name: 'tracks', amount: 0.4 }],
            tracks: [{ path: '/intake/a/1.mp3', title: 'T', index: 1 }],
          },
        ],
      },
      history: [
        { kind: 'requested', hints: { mbReleaseId: 'mb-1' } },
        { kind: 'proposed', candidateCount: 1, pinnedId: 'mb-1' },
        { kind: 'review-required', reviewKind: 'match-review' },
      ],
    };
    expect(importStatusResponseSchema.parse(payload)).toEqual(payload);
  });

  it('round-trips each review kind on a pending item', () => {
    for (const review of [
      { kind: 'no-match' },
      {
        kind: 'duplicate-review',
        incumbents: [{ artist: 'A', album: 'B', path: '/l/a' }],
        candidates: [],
      },
      { kind: 'remediation-review', failures: [{ stage: 'import-pipeline', message: 'boom' }] },
    ]) {
      const payload = { importId: 'imp-1', path: '/intake/a', review };
      expect(pendingReviewSchema.parse(payload)).toEqual(payload);
    }
  });
});
