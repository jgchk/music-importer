import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../application/__fixtures__/fakes.js';
import type { ApplyMode } from '../../domain/import/events.js';
import { BeetsBridge, defaultBridgeScript } from './bridge-adapter.js';
import type { BeetsBridgeConfig } from './bridge-adapter.js';
import type { CommandResult, CommandRunner } from './runner.js';

const CONFIG: BeetsBridgeConfig = {
  pythonBin: '/opt/venv/bin/python3',
  beetsConfigPath: '/config/beets/config.yaml',
  timeoutMs: 1_000,
  bridgeScript: '/app/bridge.py',
};

const PROPOSAL_JSON = JSON.stringify({
  status: 'proposal',
  candidates: [
    {
      data_source: 'MusicBrainz',
      album_id: 'mb-album-1',
      artist: 'The Beatles',
      album: 'Love Me Do',
      distance: 0.01,
      penalties: [{ name: 'year', amount: 0.01 }],
      tracks: [{ path: '/intake/a/01.mp3', title: 'Love Me Do', index: 1 }],
    },
  ],
  duplicates: [{ artist: 'The Beatles', album: 'Love Me Do', path: '/library/b/lmd' }],
});

function completed(stdout: string, over: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, stdout, stderr: '', timedOut: false, ...over };
}

function runnerReturning(...results: CommandResult[]): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: vi.fn((_bin: string, args: readonly string[]) => {
      calls.push([...args]);
      return Promise.resolve(results.shift() ?? completed('{}'));
    }),
  };
}

function bridge(runner: CommandRunner, config: BeetsBridgeConfig = CONFIG): BeetsBridge {
  return new BeetsBridge(silentLogger(), config, runner);
}

describe('propose', () => {
  it('passes the pins through and translates the proposal to port vocabulary', async () => {
    const runner = runnerReturning(completed(PROPOSAL_JSON));
    const outcome = (
      await bridge(runner).propose('/intake/a', {
        searchId: 'mb-1',
        searchArtist: 'The Beatles',
        searchAlbum: 'Love Me Do',
      })
    )._unsafeUnwrap();

    expect(runner.calls[0]).toEqual([
      '/app/bridge.py',
      '--config',
      '/config/beets/config.yaml',
      'propose',
      '/intake/a',
      '--search-id',
      'mb-1',
      '--search-artist',
      'The Beatles',
      '--search-album',
      'Love Me Do',
    ]);
    expect(outcome).toEqual({
      kind: 'proposal',
      candidates: [
        {
          ref: { dataSource: 'MusicBrainz', albumId: 'mb-album-1' },
          artist: 'The Beatles',
          album: 'Love Me Do',
          distance: 0.01,
          penalties: [{ name: 'year', amount: 0.01 }],
          tracks: [{ path: '/intake/a/01.mp3', title: 'Love Me Do', index: 1 }],
        },
      ],
      duplicates: [{ artist: 'The Beatles', album: 'Love Me Do', path: '/library/b/lmd' }],
    });
  });

  it('omits pin flags when no hints were supplied', async () => {
    const runner = runnerReturning(
      completed(JSON.stringify({ status: 'proposal', candidates: [], duplicates: [] })),
    );
    await bridge(runner).propose('/intake/a', {});
    expect(runner.calls[0]).toEqual([
      '/app/bridge.py',
      '--config',
      '/config/beets/config.yaml',
      'propose',
      '/intake/a',
    ]);
  });

  it('translates a bridge refusal to a doomed outcome', async () => {
    const runner = runnerReturning(
      completed(JSON.stringify({ status: 'doomed', kind: 'directory-not-found', reason: 'gone' })),
    );
    const outcome = (await bridge(runner).propose('/intake/a', {}))._unsafeUnwrap();
    expect(outcome).toEqual({ kind: 'doomed', reason: 'gone' });
  });
});

describe('apply', () => {
  const APPLIED = completed(
    JSON.stringify({ status: 'applied', location: '/library/b/lmd', failures: [] }),
  );

  const modeCases: readonly (readonly [ApplyMode, readonly string[]])[] = [
    [
      { kind: 'candidate', ref: { dataSource: 'MusicBrainz', albumId: 'a1' } },
      ['--candidate', 'MusicBrainz:a1'],
    ],
    [
      {
        kind: 'candidate',
        ref: { dataSource: 'MusicBrainz', albumId: 'a1' },
        duplicateAction: 'replace',
      },
      ['--candidate', 'MusicBrainz:a1', '--duplicate-action', 'replace'],
    ],
    [
      {
        kind: 'candidate',
        ref: { dataSource: 'MusicBrainz', albumId: 'a1' },
        duplicateAction: 'keep-both',
      },
      ['--candidate', 'MusicBrainz:a1', '--duplicate-action', 'keep-both'],
    ],
    [{ kind: 'as-is' }, ['--as-is']],
  ];

  it.each(modeCases)('builds the apply arguments for %j', async (mode, expected) => {
    const runner = runnerReturning(APPLIED);
    const outcome = (await bridge(runner).apply('/intake/a', mode))._unsafeUnwrap();
    expect(runner.calls[0]).toEqual([
      '/app/bridge.py',
      '--config',
      '/config/beets/config.yaml',
      'apply',
      '/intake/a',
      ...expected,
    ]);
    expect(outcome).toEqual({ kind: 'applied', location: '/library/b/lmd', failures: [] });
  });

  it('serializes a manual tag payload onto the command line', async () => {
    const runner = runnerReturning(APPLIED);
    const tags = {
      albumArtist: 'Jake Tape',
      album: 'Handmade',
      tracks: [{ path: 'a.mp3', title: 'First', trackNumber: 1 }],
    };
    await bridge(runner).apply('/intake/a', { kind: 'manual-tags', tags });
    expect(runner.calls[0]!.slice(-2)).toEqual(['--tags', JSON.stringify(tags)]);
  });

  it('translates a duplicate skip', async () => {
    const runner = runnerReturning(
      completed(JSON.stringify({ status: 'skipped-duplicate', incumbents: [] })),
    );
    const outcome = (await bridge(runner).apply('/intake/a', { kind: 'as-is' }))._unsafeUnwrap();
    expect(outcome).toEqual({ kind: 'skipped-duplicate', incumbents: [] });
  });

  it('translates an apply refusal to a doomed outcome', async () => {
    const runner = runnerReturning(
      completed(JSON.stringify({ status: 'doomed', kind: 'candidate-not-found', reason: 'nope' })),
    );
    const outcome = (await bridge(runner).apply('/intake/a', { kind: 'as-is' }))._unsafeUnwrap();
    expect(outcome).toEqual({ kind: 'doomed', reason: 'nope' });
  });
});

describe('validate', () => {
  it('translates the effective configuration', async () => {
    const runner = runnerReturning(
      completed(
        JSON.stringify({
          status: 'valid',
          beets_version: '2.12.0',
          library_database: '/config/beets/library.db',
          library_directory: '/music/library',
          plugins: ['musicbrainz', 'fetchart'],
          overlay: { import: { resume: false } },
        }),
      ),
    );
    const configuration = (await bridge(runner).validate())._unsafeUnwrap();
    expect(configuration).toEqual({
      beetsVersion: '2.12.0',
      libraryDatabase: '/config/beets/library.db',
      libraryDirectory: '/music/library',
      plugins: ['musicbrainz', 'fetchart'],
      overlay: { import: { resume: false } },
    });
  });

  it('maps an invalid configuration to a loud infrastructure error', async () => {
    const runner = runnerReturning(
      completed(JSON.stringify({ status: 'invalid', kind: 'config-invalid', reason: 'bad yaml' })),
    );
    const error = (await bridge(runner).validate())._unsafeUnwrapErr();
    expect(error).toMatchObject({
      kind: 'InfraError',
      operation: 'bridge.validate',
      message: 'config-invalid: bad yaml',
    });
  });
});

describe('failure surfaces', () => {
  it('maps a timeout to an InfraError', async () => {
    const runner = runnerReturning(completed('', { timedOut: true }));
    const error = (await bridge(runner).propose('/intake/a', {}))._unsafeUnwrapErr();
    expect(error.message).toContain('timed out after 1000ms');
  });

  it('maps a non-zero exit to an InfraError carrying stderr', async () => {
    const runner = runnerReturning(completed('', { code: 1, stderr: 'Traceback: boom' }));
    const error = (await bridge(runner).propose('/intake/a', {}))._unsafeUnwrapErr();
    expect(error.message).toContain('bridge exited 1');
    expect(error.message).toContain('Traceback: boom');
  });

  it('reports a signal-terminated bridge distinctly', async () => {
    const runner = runnerReturning(completed('', { code: null }));
    const error = (await bridge(runner).propose('/intake/a', {}))._unsafeUnwrapErr();
    expect(error.message).toContain('by signal');
  });

  it('maps non-JSON output to an InfraError', async () => {
    const runner = runnerReturning(completed('not json'));
    const error = (await bridge(runner).propose('/intake/a', {}))._unsafeUnwrapErr();
    expect(error.message).toContain('non-JSON output');
  });

  it('maps contract drift (schema mismatch) to an InfraError, never silent misbehavior', async () => {
    const runner = runnerReturning(completed(JSON.stringify({ status: 'proposal' })));
    const error = (await bridge(runner).propose('/intake/a', {}))._unsafeUnwrapErr();
    expect(error.message).toContain('contract validation');
  });

  it('maps a spawn rejection to an InfraError', async () => {
    const runner: CommandRunner = { run: () => Promise.reject(new Error('ENOENT')) };
    const error = (await bridge(runner).propose('/intake/a', {}))._unsafeUnwrapErr();
    expect(error.message).toContain('bridge spawn failed');
  });
});

describe('serialization (design D6)', () => {
  it('runs at most one bridge invocation at a time', async () => {
    let active = 0;
    let peak = 0;
    const runner: CommandRunner = {
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((tick) => setTimeout(tick, 10));
        active -= 1;
        return completed(JSON.stringify({ status: 'proposal', candidates: [], duplicates: [] }));
      },
    };
    const adapter = bridge(runner);
    const results = await Promise.all([
      adapter.propose('/intake/a', {}),
      adapter.propose('/intake/b', {}),
      adapter.propose('/intake/c', {}),
    ]);
    expect(results.every((result) => result.isOk())).toBe(true);
    expect(peak).toBe(1);
  });

  it('keeps the queue moving after a failed invocation', async () => {
    const runner = runnerReturning(
      completed('', { code: 1, stderr: 'boom' }),
      completed(JSON.stringify({ status: 'proposal', candidates: [], duplicates: [] })),
    );
    const adapter = bridge(runner);
    const [first, second] = await Promise.all([
      adapter.propose('/intake/a', {}),
      adapter.propose('/intake/b', {}),
    ]);
    expect(first.isErr()).toBe(true);
    expect(second.isOk()).toBe(true);
  });
});

describe('defaults', () => {
  it('resolves the shipped bridge.py beside the module by default', async () => {
    expect(defaultBridgeScript()).toMatch(/adapters\/beets\/bridge\/bridge\.py$/u);
    const runner = runnerReturning(
      completed(JSON.stringify({ status: 'proposal', candidates: [], duplicates: [] })),
    );
    const adapter = new BeetsBridge(silentLogger(), { ...CONFIG, bridgeScript: undefined }, runner);
    await adapter.propose('/intake/a', {});
    expect(runner.calls[0]![0]).toMatch(/bridge\/bridge\.py$/u);
  });
});
