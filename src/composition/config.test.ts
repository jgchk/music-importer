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

  it('leaves the intake webhook dormant when no secret is configured', () => {
    expect(loadConfig(REQUIRED)._unsafeUnwrap().intakeWebhook).toBeUndefined();
  });

  it('activates the intake webhook from a usable secret plus source root', () => {
    const secret = `whsec_${Buffer.from('intake-signing-key').toString('base64')}`;
    const config = loadConfig({
      ...REQUIRED,
      INTAKE_WEBHOOK_SECRET: secret,
      INTAKE_SOURCE_ROOT: '/downloads/import',
    })._unsafeUnwrap();
    expect(config.intakeWebhook).toEqual({ secret, sourceRoot: '/downloads/import' });
  });

  it('accepts a bare-base64 secret (the whsec_ prefix is conventional, not required)', () => {
    const secret = Buffer.from('intake-signing-key').toString('base64');
    const config = loadConfig({
      ...REQUIRED,
      INTAKE_WEBHOOK_SECRET: secret,
      INTAKE_SOURCE_ROOT: '/downloads/import',
    })._unsafeUnwrap();
    expect(config.intakeWebhook?.secret).toBe(secret);
  });

  it('rejects a malformed intake secret with a precise error', () => {
    for (const secret of ['whsec_', 'whsec_!!!not-base64!!!', 'whsec_====']) {
      const result = loadConfig({
        ...REQUIRED,
        INTAKE_WEBHOOK_SECRET: secret,
        INTAKE_SOURCE_ROOT: '/downloads/import',
      });
      expect(result._unsafeUnwrapErr()).toContain('INTAKE_WEBHOOK_SECRET');
    }
  });

  it('rejects an active receiver missing its source root', () => {
    const result = loadConfig({
      ...REQUIRED,
      INTAKE_WEBHOOK_SECRET: `whsec_${Buffer.from('k').toString('base64')}`,
    });
    expect(result._unsafeUnwrapErr()).toContain('INTAKE_SOURCE_ROOT');
  });
});
