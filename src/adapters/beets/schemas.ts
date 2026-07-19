import { z } from 'zod';

/**
 * The bridge wire contract (design D2): every JSON document the Python bridge emits is validated
 * here before anything downstream sees it, so contract drift (a beets upgrade reshaping output)
 * surfaces as an `InfraError` at the boundary, never as silent misbehavior. The recorded fixtures
 * under `test/contract/` are frozen against these same schemas.
 */

export const bridgePenaltySchema = z.object({
  name: z.string(),
  amount: z.number(),
});

export const bridgeTrackSchema = z.object({
  path: z.string(),
  title: z.string(),
  index: z.number().int(),
});

export const bridgeCandidateSchema = z.object({
  data_source: z.string().min(1),
  album_id: z.string().min(1),
  artist: z.string(),
  album: z.string(),
  distance: z.number().min(0),
  penalties: z.array(bridgePenaltySchema),
  tracks: z.array(bridgeTrackSchema),
});

export const bridgeIncumbentSchema = z.object({
  artist: z.string(),
  album: z.string(),
  path: z.string(),
});

const bridgeRefusalSchema = z.object({
  status: z.literal('doomed'),
  kind: z.string(),
  reason: z.string(),
});

export const bridgeProposeOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('proposal'),
    candidates: z.array(bridgeCandidateSchema),
    duplicates: z.array(bridgeIncumbentSchema),
  }),
  bridgeRefusalSchema,
]);

export const bridgeApplyOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    location: z.string(),
    failures: z.array(z.object({ stage: z.string(), message: z.string() })),
  }),
  z.object({
    status: z.literal('skipped-duplicate'),
    incumbents: z.array(bridgeIncumbentSchema),
  }),
  bridgeRefusalSchema,
]);

export const bridgeValidateOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('valid'),
    beets_version: z.string(),
    library_database: z.string(),
    library_directory: z.string(),
    plugins: z.array(z.string()),
    overlay: z.record(z.string(), z.unknown()),
  }),
  z.object({ status: z.literal('invalid'), kind: z.string(), reason: z.string() }),
]);

export type BridgeProposeOutput = z.infer<typeof bridgeProposeOutputSchema>;
export type BridgeApplyOutput = z.infer<typeof bridgeApplyOutputSchema>;
export type BridgeValidateOutput = z.infer<typeof bridgeValidateOutputSchema>;
