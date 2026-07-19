import { fileURLToPath } from 'node:url';
import { ResultAsync, errAsync, okAsync } from 'neverthrow';
import type { z } from 'zod';
import type { ApplyMode } from '../../domain/import/events.js';
import type { Logger } from '../../application/logging/logger.js';
import { infraError } from '../../application/ports/errors.js';
import type { InfraError } from '../../application/ports/errors.js';
import type {
  ApplyOutcome,
  ProposeOutcome,
  ProposePins,
  TaggerConfiguration,
  TaggerPort,
} from '../../application/ports/outbound-ports.js';
import type { CommandResult, CommandRunner } from './runner.js';
import { nodeCommandRunner } from './runner.js';
import {
  bridgeApplyOutputSchema,
  bridgeProposeOutputSchema,
  bridgeValidateOutputSchema,
} from './schemas.js';

/**
 * The `TaggerPort` adapter (design D2): spawn the stateless Python bridge, validate its JSON
 * against the frozen contract schemas, and translate to port vocabulary. Invocations are
 * serialized through an internal queue — beets' SQLite database gets one service-side writer at a
 * time, no matter how many effects the reactor dispatches (design D6). A non-zero exit, a timeout,
 * or contract drift all surface as `InfraError` (retryable); business refusals arrive as data.
 */
export interface BeetsBridgeConfig {
  /** The Python interpreter carrying the pinned beets install. */
  readonly pythonBin: string;
  /** The user's beets config.yaml path — authoritative for everything library-defining (D3). */
  readonly beetsConfigPath: string;
  /** Per-invocation wall-clock budget; a stuck bridge is killed and surfaced as an InfraError. */
  readonly timeoutMs: number;
  /** Override for tests; defaults to the bridge.py shipped beside this module. */
  readonly bridgeScript?: string;
}

/** The bridge.py shipped with this adapter (copied into dist alongside the compiled module). */
export function defaultBridgeScript(): string {
  return fileURLToPath(new URL('./bridge/bridge.py', import.meta.url));
}

function candidateArg(mode: Extract<ApplyMode, { kind: 'candidate' }>): readonly string[] {
  const args = ['--candidate', `${mode.ref.dataSource}:${mode.ref.albumId}`];
  if (mode.duplicateAction === 'replace') return [...args, '--duplicate-action', 'replace'];
  if (mode.duplicateAction === 'keep-both') return [...args, '--duplicate-action', 'keep-both'];
  return args;
}

function applyArgs(mode: ApplyMode): readonly string[] {
  switch (mode.kind) {
    case 'candidate':
      return candidateArg(mode);
    case 'as-is':
      return ['--as-is'];
    case 'manual-tags':
      return ['--tags', JSON.stringify(mode.tags)];
  }
}

export class BeetsBridge implements TaggerPort {
  private readonly script: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly logger: Logger,
    private readonly config: BeetsBridgeConfig,
    private readonly runner: CommandRunner = nodeCommandRunner,
  ) {
    this.script = config.bridgeScript ?? defaultBridgeScript();
  }

  propose(directory: string, pins: ProposePins): ResultAsync<ProposeOutcome, InfraError> {
    const args = [
      'propose',
      directory,
      ...(pins.searchId !== undefined ? ['--search-id', pins.searchId] : []),
      ...(pins.searchArtist !== undefined ? ['--search-artist', pins.searchArtist] : []),
      ...(pins.searchAlbum !== undefined ? ['--search-album', pins.searchAlbum] : []),
    ];
    return this.invoke('propose', args, bridgeProposeOutputSchema).map((output) => {
      if (output.status === 'doomed') return { kind: 'doomed', reason: output.reason };
      return {
        kind: 'proposal',
        candidates: output.candidates.map((candidate) => ({
          ref: { dataSource: candidate.data_source, albumId: candidate.album_id },
          artist: candidate.artist,
          album: candidate.album,
          distance: candidate.distance,
          penalties: candidate.penalties,
          tracks: candidate.tracks,
        })),
        duplicates: output.duplicates,
      };
    });
  }

  apply(directory: string, mode: ApplyMode): ResultAsync<ApplyOutcome, InfraError> {
    return this.invoke(
      'apply',
      ['apply', directory, ...applyArgs(mode)],
      bridgeApplyOutputSchema,
    ).map((output): ApplyOutcome => {
      switch (output.status) {
        case 'applied':
          return { kind: 'applied', location: output.location, failures: output.failures };
        case 'skipped-duplicate':
          return { kind: 'skipped-duplicate', incumbents: output.incumbents };
        case 'doomed':
          return { kind: 'doomed', reason: output.reason };
      }
    });
  }

  validate(): ResultAsync<TaggerConfiguration, InfraError> {
    return this.invoke('validate', ['validate'], bridgeValidateOutputSchema).andThen((output) => {
      if (output.status === 'invalid') {
        // An unusable beets config can only be fixed by an operator: fail the boot loudly (D3).
        return errAsync(infraError('bridge.validate', `${output.kind}: ${output.reason}`));
      }
      return okAsync({
        beetsVersion: output.beets_version,
        libraryDatabase: output.library_database,
        libraryDirectory: output.library_directory,
        plugins: output.plugins,
        overlay: output.overlay,
      });
    });
  }

  /** Run one bridge invocation through the serialization queue and validate its output. */
  private invoke<Schema extends z.ZodType>(
    operation: string,
    verbArgs: readonly string[],
    schema: Schema,
  ): ResultAsync<z.infer<Schema>, InfraError> {
    const args = ['--config', this.config.beetsConfigPath, ...verbArgs];
    const run = this.enqueue(() =>
      this.runner.run(this.config.pythonBin, [this.script, ...args], this.config.timeoutMs),
    );
    return ResultAsync.fromPromise(run, (cause) =>
      infraError(`bridge.${operation}`, `bridge spawn failed: ${String(cause)}`, cause),
    ).andThen((result) => this.parse(operation, result, schema));
  }

  private parse<Schema extends z.ZodType>(
    operation: string,
    result: CommandResult,
    schema: Schema,
  ): ResultAsync<z.infer<Schema>, InfraError> {
    if (result.timedOut) {
      return errAsync(
        infraError(`bridge.${operation}`, `bridge timed out after ${this.config.timeoutMs}ms`),
      );
    }
    if (result.code !== 0) {
      return errAsync(
        infraError(
          `bridge.${operation}`,
          `bridge exited ${result.code ?? 'by signal'}: ${result.stderr.slice(-2000)}`,
        ),
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      return errAsync(
        infraError(
          `bridge.${operation}`,
          `bridge emitted non-JSON output: ${result.stdout.slice(0, 500)}`,
        ),
      );
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      // Contract drift (e.g. an unverified beets upgrade): loud, retryable, never silent.
      this.logger.error(
        { operation, issues: parsed.error.issues },
        'bridge output failed contract validation',
      );
      return errAsync(
        infraError(`bridge.${operation}`, `bridge output failed contract validation`),
      );
    }
    return okAsync(parsed.data);
  }

  /** Chain invocations so at most one bridge process runs at a time (design D6). */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
