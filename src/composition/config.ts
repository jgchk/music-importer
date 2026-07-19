import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { z } from 'zod';

/**
 * Environment-derived configuration (12-factor): the composition root's testable seam. All config
 * comes from the environment; validation happens once, at startup, and a bad environment aborts
 * boot with a precise error rather than failing later at first use.
 */

const envSchema = z.object({
  HTTP_PORT: z.coerce.number().int().positive().default(3000),
  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  /** The service's own event-store SQLite file — never beets' library.db. */
  DATABASE_FILE: z.string().min(1).default('data/events.db'),
  /** The intake directory all submissions live under; rejection cleanup never leaves it. */
  INTAKE_ROOT: z.string().min(1),
  /** The user's beets config.yaml — authoritative for everything library-defining (design D3). */
  BEETS_CONFIG: z.string().min(1),
  /** The Python interpreter carrying the pinned beets install. */
  BRIDGE_PYTHON: z.string().min(1).default('python3'),
  /** Wall-clock budget per bridge invocation (a full apply can run plugins over a network). */
  BRIDGE_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /**
   * A candidate at or under this beets distance auto-applies (design D4). The default is beets'
   * own strong-match threshold (`match.strong_rec_thresh`).
   */
  AUTO_APPLY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.04),
});

export interface AppConfig {
  readonly httpPort: number;
  readonly host: string;
  readonly databaseFile: string;
  readonly intakeRoot: string;
  readonly beetsConfigPath: string;
  readonly bridgePython: string;
  readonly bridgeTimeoutMs: number;
  readonly autoApplyThreshold: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Result<AppConfig, string> {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) return err(parsed.error.message);
  return ok({
    httpPort: parsed.data.HTTP_PORT,
    host: parsed.data.HTTP_HOST,
    databaseFile: parsed.data.DATABASE_FILE,
    intakeRoot: parsed.data.INTAKE_ROOT,
    beetsConfigPath: parsed.data.BEETS_CONFIG,
    bridgePython: parsed.data.BRIDGE_PYTHON,
    bridgeTimeoutMs: parsed.data.BRIDGE_TIMEOUT_MS,
    autoApplyThreshold: parsed.data.AUTO_APPLY_THRESHOLD,
  });
}
