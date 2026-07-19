import { z } from 'zod';

/**
 * The consumer-owned tolerant reader for music-downloader's webhook events (design D1). These
 * schemas read ONLY what the importer uses and ignore unknown fields at every level (zod objects
 * strip unrecognized keys), so the sender can evolve its payload additively without breaking this
 * receiver. Nothing here is imported from the sender's codebase — conformance against its frozen
 * recorded fixture is enforced by the contract tier (test/contract).
 */

/** The envelope fields needed to dispatch: unknown `type`s are acknowledged and ignored. */
export const intakeEventEnvelopeSchema = z.object({
  type: z.string().min(1),
});

/**
 * The `acquisition.fulfilled` fields the importer consumes. `target.type` is an open string (the
 * sender may add target kinds); `musicbrainzReleaseId` tolerates null or absent. `data.location`
 * is an absolute directory in the SENDER's filesystem namespace — re-rooted before use.
 */
export const acquisitionFulfilledSchema = z.object({
  type: z.literal('acquisition.fulfilled'),
  data: z.object({
    acquisitionId: z.string().min(1),
    location: z.string().min(1),
    target: z.object({
      type: z.string().min(1),
      artist: z.string().min(1),
      title: z.string().min(1),
      musicbrainzReleaseId: z.string().min(1).nullish(),
    }),
  }),
});

export type IntakeEventEnvelopeDto = z.infer<typeof intakeEventEnvelopeSchema>;
export type AcquisitionFulfilledDto = z.infer<typeof acquisitionFulfilledSchema>;
