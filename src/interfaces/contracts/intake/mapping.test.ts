import { describe, expect, it } from 'vitest';
import { fulfilledToSubmission, rerootLocation } from './mapping.js';
import type { AcquisitionFulfilledDto } from './schemas.js';

const CANDIDATE = { username: 'peer1', path: 'peer1/Kid A [FLAC]', sizeBytes: 1000 };

function fulfilled(
  target: Partial<AcquisitionFulfilledDto['data']['target']> = {},
): AcquisitionFulfilledDto {
  return {
    type: 'acquisition.fulfilled',
    data: {
      acquisitionId: 'acq-1',
      location: '/downloads/import/Radiohead - Kid A',
      target: {
        type: 'album',
        artist: 'Radiohead',
        title: 'Kid A',
        musicbrainzReleaseId: 'mb-release-1',
        ...target,
      },
      candidate: CANDIDATE,
    },
  };
}

describe('fulfilledToSubmission', () => {
  it('maps an album target to a fully hinted submission carrying the candidate', () => {
    expect(fulfilledToSubmission(fulfilled())).toEqual({
      acquisitionId: 'acq-1',
      location: '/downloads/import/Radiohead - Kid A',
      hints: { mbReleaseId: 'mb-release-1', artist: 'Radiohead', album: 'Kid A' },
      candidate: CANDIDATE,
    });
  });

  it('submits without a candidate when the delivery carried none', () => {
    const dto = fulfilled();
    const submission = fulfilledToSubmission({
      ...dto,
      data: { ...dto.data, candidate: undefined },
    });
    expect(submission.candidate).toBeUndefined();
  });

  it('drops the release-id hint when the sender has none', () => {
    const submission = fulfilledToSubmission(fulfilled({ musicbrainzReleaseId: null }));
    expect(submission.hints.mbReleaseId).toBeUndefined();
  });

  it('does not hint the album for a non-album target (title names a track, not a release)', () => {
    const submission = fulfilledToSubmission(fulfilled({ type: 'track', title: 'Idioteque' }));
    expect(submission.hints).toEqual({
      mbReleaseId: 'mb-release-1',
      artist: 'Radiohead',
      album: undefined,
    });
  });
});

describe('rerootLocation', () => {
  const ROOTS = { sourceRoot: '/downloads/import', intakeRoot: '/music/intake' };

  it('strips the source root and joins the remainder onto the intake root', () => {
    const result = rerootLocation({ location: '/downloads/import/Artist - Album', ...ROOTS });
    expect(result._unsafeUnwrap()).toBe('/music/intake/Artist - Album');
  });

  it('handles nested remainders and cosmetic trailing slashes on either side', () => {
    const result = rerootLocation({
      location: '/downloads/import/Artist/Album/',
      sourceRoot: '/downloads/import/',
      intakeRoot: '/music/intake/',
    });
    expect(result._unsafeUnwrap()).toBe('/music/intake/Artist/Album');
  });

  it('rejects a location outside the source root, or equal to it', () => {
    for (const location of ['/elsewhere/Artist - Album', '/downloads/import', 'relative/path']) {
      expect(rerootLocation({ location, ...ROOTS })._unsafeUnwrapErr()).toBe('OutsideSourceRoot');
    }
  });

  it('rejects escape attempts through empty, dot, or dot-dot segments', () => {
    for (const location of [
      '/downloads/import//Artist',
      '/downloads/import/./Artist',
      '/downloads/import/../secrets',
    ]) {
      expect(rerootLocation({ location, ...ROOTS })._unsafeUnwrapErr()).toBe('OutsideSourceRoot');
    }
  });
});
