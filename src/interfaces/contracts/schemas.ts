import { z } from 'zod';

/**
 * The versioned wire contracts: one zod source of truth that drives HTTP request/response
 * validation (via `fastify-type-provider-zod`), the published OpenAPI document (via
 * `@fastify/swagger`), and the MCP tool JSON Schemas (via `z.toJSONSchema`) — so the three
 * surfaces cannot drift. These DTOs are deliberately *separate* from the domain models (inbound
 * anti-corruption): they evolve additively within `/api/v1` and never expose domain types on the
 * wire.
 */

// --- Enumerations (wire copies, intentionally decoupled from the domain's own unions) ----------

export const importPhaseSchema = z.enum([
  'empty',
  'requested',
  'proposing',
  'awaiting-review',
  'applying',
  'applied',
  'rejected',
]);

export const reviewKindSchema = z.enum([
  'match-review',
  'no-match',
  'duplicate-review',
  'remediation-review',
]);

export const resolutionVerbSchema = z.enum([
  'apply-candidate',
  'supply-id',
  'refresh-candidates',
  'manual-tags',
  'import-as-is',
  'reject',
  'reject-and-retry-download',
  'accept',
  'retry-enrichment',
]);

export const duplicateActionSchema = z.enum(['replace', 'keep-both']);

// --- Shared shapes -----------------------------------------------------------------------------

export const candidateRefSchema = z.object({
  dataSource: z.string().min(1),
  albumId: z.string().min(1),
});

export const candidatePenaltySchema = z.object({
  name: z.string(),
  amount: z.number(),
});

export const trackMappingSchema = z.object({
  path: z.string(),
  title: z.string(),
  index: z.number().int(),
});

export const candidateSchema = z.object({
  ref: candidateRefSchema,
  artist: z.string(),
  album: z.string(),
  distance: z.number(),
  penalties: z.array(candidatePenaltySchema),
  tracks: z.array(trackMappingSchema),
});

export const incumbentSchema = z.object({
  artist: z.string(),
  album: z.string(),
  path: z.string(),
});

export const applyFailureSchema = z.object({
  stage: z.string(),
  message: z.string(),
});

export const importHintsSchema = z.object({
  mbReleaseId: z.string().min(1).optional(),
  artist: z.string().min(1).optional(),
  album: z.string().min(1).optional(),
});

// --- Submit ------------------------------------------------------------------------------------

export const submitImportRequestSchema = z.object({
  path: z.string().min(1),
  hints: importHintsSchema.optional(),
});

export const submitImportResponseSchema = z.object({
  importId: z.string(),
  statusUrl: z.string(),
});

// --- Reviews -----------------------------------------------------------------------------------

export const reviewSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('match-review'),
    hinted: z.boolean(),
    best: candidateRefSchema.optional(),
    candidates: z.array(candidateSchema),
  }),
  z.object({ kind: z.literal('no-match') }),
  z.object({
    kind: z.literal('duplicate-review'),
    incumbents: z.array(incumbentSchema),
    candidates: z.array(candidateSchema),
  }),
  z.object({
    kind: z.literal('remediation-review'),
    failures: z.array(applyFailureSchema),
  }),
]);

export const manualTrackTagsSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().min(1).optional(),
  trackNumber: z.number().int().positive(),
  discNumber: z.number().int().positive().optional(),
});

export const manualTagsSchema = z.object({
  albumArtist: z.string().min(1),
  album: z.string().min(1),
  year: z.number().int().optional(),
  tracks: z.array(manualTrackTagsSchema).min(1),
});

export const resolveReviewRequestSchema = z.discriminatedUnion('verb', [
  z.object({
    verb: z.literal('apply-candidate'),
    candidate: candidateRefSchema,
    duplicateAction: duplicateActionSchema.optional(),
  }),
  z.object({ verb: z.literal('supply-id'), mbReleaseId: z.string().min(1) }),
  z.object({ verb: z.literal('refresh-candidates') }),
  z.object({ verb: z.literal('manual-tags'), tags: manualTagsSchema }),
  z.object({ verb: z.literal('import-as-is') }),
  z.object({ verb: z.literal('reject'), reason: z.string().min(1).optional() }),
  z.object({
    /**
     * Reject (files deleted, import terminal `rejected`) AND record a release verdict so the
     * delivering downloader retries the acquisition with a different copy. Only for imports that
     * arrived from the downloader with a retained candidate; otherwise refused with
     * `NoRetainedCandidate` (plain `reject` remains available). Use `reject` for "wrong thing to
     * have", this verb for "right thing, bad copy".
     */
    verb: z.literal('reject-and-retry-download'),
    reasons: z.array(z.string().min(1)).optional(),
  }),
  z.object({ verb: z.literal('accept') }),
  z.object({ verb: z.literal('retry-enrichment') }),
]);

export const resolveReviewResponseSchema = z.object({
  importId: z.string(),
});

export const pendingReviewSchema = z.object({
  importId: z.string(),
  path: z.string(),
  review: reviewSchema,
});

export const reviewListResponseSchema = z.object({
  reviews: z.array(pendingReviewSchema),
});

// --- Status ------------------------------------------------------------------------------------

export const historyEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('requested'), hints: importHintsSchema.optional() }),
  z.object({
    kind: z.literal('proposed'),
    candidateCount: z.number().int(),
    pinnedId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('auto-apply-selected'),
    candidate: candidateRefSchema,
    distance: z.number(),
  }),
  z.object({ kind: z.literal('review-required'), reviewKind: reviewKindSchema }),
  z.object({ kind: z.literal('review-resolved'), resolution: resolutionVerbSchema }),
  z.object({ kind: z.literal('applied'), location: z.string() }),
  z.object({ kind: z.literal('remediation-required'), failures: z.array(applyFailureSchema) }),
  z.object({ kind: z.literal('rejected'), reason: z.string(), filesDeleted: z.boolean() }),
  z.object({
    kind: z.literal('release-verdict-recorded'),
    acquisitionId: z.string(),
    reasons: z.array(z.string()),
  }),
]);

export const importStatusResponseSchema = z.object({
  importId: z.string(),
  path: z.string().optional(),
  status: importPhaseSchema,
  location: z.string().optional(),
  review: reviewSchema.optional(),
  rejection: z.object({ reason: z.string(), filesDeleted: z.boolean() }).optional(),
  history: z.array(historyEntrySchema),
});

export const importListResponseSchema = z.object({
  imports: z.array(importStatusResponseSchema),
});

export const importIdParamsSchema = z.object({
  id: z.string().min(1),
});

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});

// Note: the `resolve_review` MCP tool no longer derives its schema here. Anthropic tool-use cannot
// represent the `oneOf` that a discriminated-union resolution emits, so the MCP adapter presents a
// flat, union-free equivalent (`src/interfaces/mcp/resolve-review-tool.ts`) and translates back
// onto `ResolveReviewRequestDto`. The HTTP/OpenAPI surface keeps the union unchanged.

// --- Inferred DTO types (the interface layer's public vocabulary) ------------------------------

export type SubmitImportRequestDto = z.infer<typeof submitImportRequestSchema>;
export type SubmitImportResponseDto = z.infer<typeof submitImportResponseSchema>;
export type ResolveReviewRequestDto = z.infer<typeof resolveReviewRequestSchema>;
export type ReviewDto = z.infer<typeof reviewSchema>;
export type PendingReviewDto = z.infer<typeof pendingReviewSchema>;
export type ImportStatusResponseDto = z.infer<typeof importStatusResponseSchema>;
export type ImportListResponseDto = z.infer<typeof importListResponseSchema>;
export type ErrorResponseDto = z.infer<typeof errorResponseSchema>;
