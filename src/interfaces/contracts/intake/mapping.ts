import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import type { DeliveredCandidate, ImportHints } from '../../../domain/import/events.js';
import type { AcquisitionFulfilledDto } from './schemas.js';

/**
 * The anti-corruption mapping from the sender's `acquisition.fulfilled` vocabulary to the native
 * submission vocabulary, plus the path re-rooting between the two filesystem namespaces (design
 * D4): the sender's `location` must fall strictly under its configured source root, and the
 * remainder is re-joined onto the importer's own intake root.
 */

/** What an accepted delivery translates to: the acquisition linkage plus the native submission. */
export interface AcquisitionSubmission {
  readonly acquisitionId: string;
  /** The release directory in the SENDER's namespace, to be re-rooted before use. */
  readonly location: string;
  readonly hints: ImportHints;
  /** The delivered candidate's identity, retained for a later release verdict (if readable). */
  readonly candidate?: DeliveredCandidate;
}

export function fulfilledToSubmission(dto: AcquisitionFulfilledDto): AcquisitionSubmission {
  const { acquisitionId, location, target, candidate } = dto.data;
  return {
    acquisitionId,
    location,
    hints: {
      mbReleaseId: target.musicbrainzReleaseId ?? undefined,
      artist: target.artist,
      // `title` names the release only for album targets; other kinds keep the search unpinned.
      album: target.type === 'album' ? target.title : undefined,
    },
    candidate,
  };
}

const stripTrailingSlashes = (path: string): string => path.replace(/\/+$/u, '');

/**
 * Re-root a sender-namespace location onto the importer's intake root: strip the source root and
 * join the remainder onto the intake root. A location that does not fall strictly under the
 * source root — or that carries empty/`.`/`..` segments (escape attempts) — is rejected.
 */
export function rerootLocation(args: {
  readonly location: string;
  readonly sourceRoot: string;
  readonly intakeRoot: string;
}): Result<string, 'OutsideSourceRoot'> {
  const location = stripTrailingSlashes(args.location);
  const prefix = `${stripTrailingSlashes(args.sourceRoot)}/`;
  if (!location.startsWith(prefix)) return err('OutsideSourceRoot');
  const segments = location.slice(prefix.length).split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return err('OutsideSourceRoot');
  }
  return ok(`${stripTrailingSlashes(args.intakeRoot)}/${segments.join('/')}`);
}
