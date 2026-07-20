import { z } from 'zod';
import {
  candidateRefSchema,
  duplicateActionSchema,
  manualTagsSchema,
  resolutionVerbSchema,
} from '../contracts/index.js';
import type { ResolveReviewRequestDto } from '../contracts/index.js';

/**
 * The MCP-local input schema for the `resolve_review` tool. It exists solely because Anthropic
 * tool-use / Claude Desktop cannot represent JSON-Schema unions (`oneOf`/`anyOf`/`allOf`): the
 * wire contract models a resolution as a `discriminatedUnion` over the verb, which `z.toJSONSchema`
 * emits as a `oneOf`, and any field advertised as a union degrades to type "any" — the model then
 * cannot form valid arguments and every call fails with "invalid arguments".
 *
 * So this adapter presents a *flat* alternative: one object with a `verb` discriminator enum plus
 * the union of every verb's optional fields, and enforces "which fields belong to which verb"
 * server-side with `superRefine`. Nested plain objects (`candidate`, `tags`) are union-free and
 * stay as objects. Well-formed calls translate straight back onto the existing wire DTO
 * (`ResolveReviewRequestDto`) and the unchanged resolve-review use-case, so behaviour is identical
 * — only the advertised shape is flatter and the error messages are specific.
 */

/** The fields that may accompany a verb — the flat union of every verb's payload. */
const EXTRA_FIELDS = [
  'candidate',
  'duplicateAction',
  'mbReleaseId',
  'tags',
  'reason',
  'reasons',
] as const;

type ExtraField = (typeof EXTRA_FIELDS)[number];
type ResolutionVerb = z.infer<typeof resolutionVerbSchema>;

interface VerbRule {
  /** The single field this verb requires, with the message shown when it is absent. */
  readonly required?: { readonly field: ExtraField; readonly message: string };
  /** Fields this verb may carry but does not require. */
  readonly optional: readonly ExtraField[];
}

/**
 * The per-verb field contract, mirroring the wire `resolveReviewRequestSchema` union exactly:
 * apply-candidate needs a candidate (duplicateAction optional); supply-id needs an mbReleaseId;
 * manual-tags needs tags; reject may carry a reason; reject-and-retry-download may carry reasons;
 * the remaining verbs take no extra fields.
 */
const VERB_RULES: Record<ResolutionVerb, VerbRule> = {
  'apply-candidate': {
    required: {
      field: 'candidate',
      message: 'verb=apply-candidate requires candidate.{dataSource,albumId}',
    },
    optional: ['duplicateAction'],
  },
  'supply-id': {
    required: { field: 'mbReleaseId', message: 'verb=supply-id requires mbReleaseId' },
    optional: [],
  },
  'refresh-candidates': { optional: [] },
  'manual-tags': {
    required: {
      field: 'tags',
      message: 'verb=manual-tags requires tags.{albumArtist,album,tracks}',
    },
    optional: [],
  },
  'import-as-is': { optional: [] },
  reject: { optional: ['reason'] },
  'reject-and-retry-download': { optional: ['reasons'] },
  accept: { optional: [] },
  'retry-enrichment': { optional: [] },
};

const resolutionSchema = z
  .object({
    verb: resolutionVerbSchema.describe(
      'Which action to take. apply-candidate: also give candidate={dataSource,albumId} (+ optional ' +
        'duplicateAction). supply-id: also give mbReleaseId. manual-tags: also give tags. reject: ' +
        'optional reason. reject-and-retry-download: optional reasons. refresh-candidates, ' +
        'import-as-is, accept, retry-enrichment: no other fields.',
    ),
    candidate: candidateRefSchema
      .optional()
      .describe(
        'Required for apply-candidate: the release to apply, e.g. {dataSource:"MusicBrainz", albumId:"..."}.',
      ),
    duplicateAction: duplicateActionSchema
      .optional()
      .describe(
        'Optional for apply-candidate when a duplicate is detected: "replace" or "keep-both".',
      ),
    mbReleaseId: z
      .string()
      .min(1)
      .optional()
      .describe('Required for supply-id: the MusicBrainz release id to enrich against.'),
    tags: manualTagsSchema
      .optional()
      .describe(
        'Required for manual-tags: the full manual tag payload {albumArtist, album, year?, tracks}.',
      ),
    reason: z
      .string()
      .min(1)
      .optional()
      .describe('Optional for reject: a human-readable reason the files are being discarded.'),
    reasons: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Optional for reject-and-retry-download: reasons recorded on the release verdict for the downloader.',
      ),
  })
  .describe("A single flat resolution object: a verb discriminator plus that verb's fields.")
  .superRefine((value, ctx) => {
    const rule = VERB_RULES[value.verb];
    const allowed = new Set<ExtraField>([
      ...(rule.required ? [rule.required.field] : []),
      ...rule.optional,
    ]);
    if (rule.required && value[rule.required.field] === undefined) {
      ctx.addIssue({ code: 'custom', path: [rule.required.field], message: rule.required.message });
    }
    for (const field of EXTRA_FIELDS) {
      if (value[field] !== undefined && !allowed.has(field)) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `verb=${value.verb} does not accept the field "${field}"`,
        });
      }
    }
  });

/** The full flat argument schema for the `resolve_review` tool: the import id + a flat resolution. */
export const resolveReviewToolSchema = z.object({
  id: z.string().min(1).describe('The id of the import whose pending review is being resolved.'),
  resolution: resolutionSchema,
});

/** The advertised JSON Schema — guaranteed free of oneOf/anyOf/allOf (verified in tests). */
export const resolveReviewInputSchema = z.toJSONSchema(resolveReviewToolSchema);

export const resolveReviewDescription =
  'Resolve a pending review with a single flat verb + its fields (no unions). Verbs: ' +
  'apply-candidate (candidate={dataSource,albumId}, optional duplicateAction), ' +
  'supply-id (mbReleaseId), manual-tags (tags), reject (optional reason), ' +
  'reject-and-retry-download (optional reasons), refresh-candidates, import-as-is, accept, ' +
  'retry-enrichment. Example: {id:"imp-1", resolution:{verb:"apply-candidate", candidate:' +
  '{dataSource:"MusicBrainz", albumId:"abc"}}}. reject deletes the files ("wrong thing to have"); ' +
  'reject-and-retry-download additionally records a release verdict so the delivering downloader ' +
  'retries with a different copy ("right thing, bad copy") — only for downloader-delivered imports ' +
  'with a retained candidate, otherwise refused with NoRetainedCandidate.';

/**
 * Translate a validated flat resolution onto the existing wire DTO. `superRefine` has already
 * guaranteed that exactly the fields the verb allows are present, so every wire union member's
 * shape is satisfied — the assertion narrows the flat superset to the discriminated union the
 * unchanged `resolutionToDomain` mapping expects.
 */
export function toResolveReviewRequest(
  resolution: z.infer<typeof resolveReviewToolSchema>['resolution'],
): ResolveReviewRequestDto {
  return resolution as ResolveReviewRequestDto;
}

/** Render a parse failure as a specific, actionable message instead of a bare "invalid arguments". */
export function describeResolveReviewError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}
