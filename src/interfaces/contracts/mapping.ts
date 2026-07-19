import type { ImportHints, ProposedCandidate, Resolution } from '../../domain/import/events.js';
import type { OpenReview } from '../../domain/import/import.js';
import type {
  ImportStatusView,
  PendingReviewView,
} from '../../application/projections/read-models.js';
import type {
  ImportStatusResponseDto,
  PendingReviewDto,
  ResolveReviewRequestDto,
  ReviewDto,
  SubmitImportRequestDto,
} from './schemas.js';

/**
 * The anti-corruption mapping between the wire DTOs and the domain/application vocabulary. Both
 * inbound directions (submission hints, resolution verbs) and outbound views flow through here,
 * so the interfaces never touch domain types directly and the wire shapes can evolve additively
 * on their own.
 */

export function hintsToDomain(dto: SubmitImportRequestDto): ImportHints | undefined {
  const hints = dto.hints;
  if (hints === undefined) return undefined;
  return { mbReleaseId: hints.mbReleaseId, artist: hints.artist, album: hints.album };
}

export function resolutionToDomain(dto: ResolveReviewRequestDto): Resolution {
  switch (dto.verb) {
    case 'apply-candidate':
      return {
        kind: 'apply-candidate',
        ref: { dataSource: dto.candidate.dataSource, albumId: dto.candidate.albumId },
        duplicateAction: dto.duplicateAction,
      };
    case 'supply-id':
      return { kind: 'supply-id', mbReleaseId: dto.mbReleaseId };
    case 'refresh-candidates':
      return { kind: 'refresh-candidates' };
    case 'manual-tags':
      return { kind: 'manual-tags', tags: dto.tags };
    case 'import-as-is':
      return { kind: 'import-as-is' };
    case 'reject':
      return { kind: 'reject', reason: dto.reason };
    case 'reject-and-retry-download':
      return { kind: 'reject-and-retry-download', reasons: dto.reasons };
    case 'accept':
      return { kind: 'accept' };
    case 'retry-enrichment':
      return { kind: 'retry-enrichment' };
  }
}

function candidateToDto(candidate: ProposedCandidate) {
  return {
    ref: { dataSource: candidate.ref.dataSource, albumId: candidate.ref.albumId },
    artist: candidate.artist,
    album: candidate.album,
    distance: candidate.distance,
    penalties: [...candidate.penalties],
    tracks: [...candidate.tracks],
  };
}

export function reviewToDto(review: OpenReview): ReviewDto {
  const cause = review.cause;
  switch (cause.kind) {
    case 'match-review':
      return {
        kind: 'match-review',
        hinted: cause.hinted,
        best: cause.best === undefined ? undefined : { ...cause.best },
        candidates: review.candidates.map(candidateToDto),
      };
    case 'no-match':
      return { kind: 'no-match' };
    case 'duplicate-review':
      return {
        kind: 'duplicate-review',
        incumbents: [...cause.incumbents],
        candidates: review.candidates.map(candidateToDto),
      };
    case 'remediation-review':
      return { kind: 'remediation-review', failures: [...cause.failures] };
  }
}

export function statusViewToDto(view: ImportStatusView): ImportStatusResponseDto {
  return {
    importId: view.importId,
    path: view.directory,
    status: view.phase,
    location: view.location,
    review: view.openReview === undefined ? undefined : reviewToDto(view.openReview),
    rejection: view.rejection === undefined ? undefined : { ...view.rejection },
    history: view.history.map(
      (entry) => ({ ...entry }) as ImportStatusResponseDto['history'][number],
    ),
  };
}

export function pendingReviewToDto(view: PendingReviewView): PendingReviewDto {
  return {
    importId: view.importId,
    path: view.directory,
    review: reviewToDto(view.review),
  };
}
