import { z } from 'zod';

/**
 * The outbound published-event contracts (change: outbound-release-verdicts): the single,
 * producer-owned source of truth for what this tool announces to the world. Every outgoing payload
 * is validated against these schemas before delivery; `scripts/contracts/` generates the committed
 * JSON Schema artifacts from them, and the contract-test tier enforces the evolution rule —
 * **additive-only within an event type; a breaking change is a new `type`**.
 *
 * The payload shape is chosen to satisfy music-downloader's published tolerant-reader needs
 * (acquisition id, candidate `{username, path, sizeBytes?}`, verdict `rejected`, reasons):
 * `sizeBytes` is OMITTED when unknown — never null — because the receiver reads it as an optional
 * number. The vocabulary stays this tool's own; consumers translate at their anti-corruption
 * layers.
 */

export const RELEASE_VERDICT_TYPE = 'release.verdict';

export const releaseVerdictDataSchema = z.object({
  /** The originating acquisition — the receiver's revival key. */
  acquisitionId: z.string().min(1),
  /** The delivered candidate's identity, echoed for the receiver's stale-guard. */
  candidate: z.object({
    username: z.string(),
    path: z.string(),
    sizeBytes: z.number().optional(),
  }),
  /** The adjudication. Only `rejected` exists today; new verdicts are additive later. */
  verdict: z.literal('rejected'),
  /** The reviewer's reasons (possibly empty). */
  reasons: z.array(z.string()),
});

/** The Standard Webhooks body: `{type, timestamp, data}`. */
export const releaseVerdictEventSchema = z.object({
  type: z.literal(RELEASE_VERDICT_TYPE),
  timestamp: z.iso.datetime(), // when the verdict was recorded (stable across redeliveries)
  data: releaseVerdictDataSchema,
});

export type ReleaseVerdictData = z.infer<typeof releaseVerdictDataSchema>;
export type ReleaseVerdictEvent = z.infer<typeof releaseVerdictEventSchema>;
