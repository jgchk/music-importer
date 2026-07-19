import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const REQUIRED = {
  INTAKE_ROOT: '/music/intake',
  BEETS_CONFIG: '/config/beets/config.yaml',
};

describe('loadConfig', () => {
  it('applies the documented defaults around the required variables', () => {
    expect(loadConfig(REQUIRED)._unsafeUnwrap()).toEqual({
      httpPort: 3000,
      host: '0.0.0.0',
      databaseFile: 'data/events.db',
      intakeRoot: '/music/intake',
      beetsConfigPath: '/config/beets/config.yaml',
      bridgePython: 'python3',
      bridgeTimeoutMs: 600_000,
      autoApplyThreshold: 0.04,
    });
  });

  it('reads explicit overrides from the environment', () => {
    const config = loadConfig({
      ...REQUIRED,
      HTTP_PORT: '4000',
      HTTP_HOST: '127.0.0.1',
      DATABASE_FILE: '/data/importer.db',
      BRIDGE_PYTHON: '/opt/beets-venv/bin/python3',
      BRIDGE_TIMEOUT_MS: '120000',
      AUTO_APPLY_THRESHOLD: '0.25',
    })._unsafeUnwrap();
    expect(config).toMatchObject({
      httpPort: 4000,
      host: '127.0.0.1',
      databaseFile: '/data/importer.db',
      bridgePython: '/opt/beets-venv/bin/python3',
      bridgeTimeoutMs: 120_000,
      autoApplyThreshold: 0.25,
    });
  });

  it('rejects a missing intake root or beets config with a precise error', () => {
    expect(loadConfig({ BEETS_CONFIG: '/c.yaml' }).isErr()).toBe(true);
    expect(loadConfig({ INTAKE_ROOT: '/intake' }).isErr()).toBe(true);
  });

  it('rejects malformed numbers and out-of-range thresholds', () => {
    expect(loadConfig({ ...REQUIRED, HTTP_PORT: 'not-a-port' }).isErr()).toBe(true);
    expect(loadConfig({ ...REQUIRED, AUTO_APPLY_THRESHOLD: '1.5' }).isErr()).toBe(true);
  });
});
