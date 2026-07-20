import Fastify from 'fastify';
import type { JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  RESOURCE_METADATA_PATH,
  bearerTokenOf,
  claimsSatisfy,
  mcpBearerPreHandler,
  protectedResourceMetadata,
  registerMcpAuth,
  resourceMetadataUrl,
  verifyBearer,
} from './bearer-auth.js';
import type { McpAuthOptions } from './bearer-auth.js';

const ISSUER = 'https://auth.jake.cafe/realms/homelab';
const RESOURCE = 'https://music-importer.jake.cafe/mcp';

function options(verify: (token: string) => Promise<JWTPayload>): McpAuthOptions {
  return { issuer: ISSUER, resource: RESOURCE, verify };
}

describe('protectedResourceMetadata', () => {
  it('builds the RFC 9728 document naming the issuer and resource', () => {
    expect(protectedResourceMetadata(ISSUER, RESOURCE)).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
    });
  });
});

describe('resourceMetadataUrl', () => {
  it('anchors the metadata path on the resource origin (dropping the /mcp path)', () => {
    expect(resourceMetadataUrl(RESOURCE)).toBe(
      'https://music-importer.jake.cafe/.well-known/oauth-protected-resource',
    );
  });
});

describe('bearerTokenOf', () => {
  it('extracts the token from a Bearer header (scheme case-insensitive)', () => {
    expect(bearerTokenOf('Bearer abc.def.ghi')._unsafeUnwrap()).toBe('abc.def.ghi');
    expect(bearerTokenOf('bearer abc.def.ghi')._unsafeUnwrap()).toBe('abc.def.ghi');
  });

  it('rejects a missing header, the wrong scheme, or an empty token', () => {
    expect(bearerTokenOf(undefined)._unsafeUnwrapErr()).toBe('MissingToken');
    expect(bearerTokenOf('Basic abc')._unsafeUnwrapErr()).toBe('MissingToken');
    expect(bearerTokenOf('Bearer ')._unsafeUnwrapErr()).toBe('MissingToken');
    expect(bearerTokenOf('Bearer')._unsafeUnwrapErr()).toBe('MissingToken');
  });
});

describe('claimsSatisfy', () => {
  it('requires the issuer to match', () => {
    expect(
      claimsSatisfy({ iss: 'https://evil', aud: RESOURCE }, { issuer: ISSUER, resource: RESOURCE }),
    ).toBe(false);
  });

  it('accepts the resource in aud (string or array), resource, or azp (RFC 8707)', () => {
    const base = { iss: ISSUER } as JWTPayload;
    const expected = { issuer: ISSUER, resource: RESOURCE };
    expect(claimsSatisfy({ ...base, aud: RESOURCE }, expected)).toBe(true);
    expect(claimsSatisfy({ ...base, aud: ['other', RESOURCE] }, expected)).toBe(true);
    expect(claimsSatisfy({ ...base, resource: RESOURCE }, expected)).toBe(true);
    expect(claimsSatisfy({ ...base, azp: RESOURCE }, expected)).toBe(true);
    expect(claimsSatisfy({ ...base, resource: ['x', RESOURCE] }, expected)).toBe(true);
  });

  it('rejects when the resource appears in no audience claim', () => {
    expect(
      claimsSatisfy(
        { iss: ISSUER, aud: 'https://someone-else/mcp' },
        { issuer: ISSUER, resource: RESOURCE },
      ),
    ).toBe(false);
    expect(claimsSatisfy({ iss: ISSUER }, { issuer: ISSUER, resource: RESOURCE })).toBe(false);
  });
});

describe('verifyBearer', () => {
  const good: JWTPayload = { iss: ISSUER, aud: RESOURCE };

  it('returns the claims for a valid, correctly-audienced token', async () => {
    const result = await verifyBearer(
      options(() => Promise.resolve(good)),
      `Bearer good.token`,
    );
    expect(result._unsafeUnwrap()).toEqual(good);
  });

  it('fails with MissingToken when the header is absent or not a Bearer credential', async () => {
    const result = await verifyBearer(
      options(() => Promise.resolve(good)),
      undefined,
    );
    expect(result._unsafeUnwrapErr()).toBe('MissingToken');
  });

  it('fails with InvalidToken when the verifier rejects (bad signature/expiry)', async () => {
    const result = await verifyBearer(
      options(() => Promise.reject(new Error('bad signature'))),
      'Bearer bad.token',
    );
    expect(result._unsafeUnwrapErr()).toBe('InvalidToken');
  });

  it('fails with InvalidToken when the claims do not bind to this resource', async () => {
    const result = await verifyBearer(
      options(() => Promise.resolve({ iss: ISSUER, aud: 'https://elsewhere/mcp' })),
      'Bearer wrong.aud',
    );
    expect(result._unsafeUnwrapErr()).toBe('InvalidToken');
  });
});

describe('registerMcpAuth + mcpBearerPreHandler over Fastify', () => {
  async function appWith(verify: (token: string) => Promise<JWTPayload>) {
    const app = Fastify();
    const opts = options(verify);
    registerMcpAuth(app, opts);
    app.post('/guarded', { preHandler: mcpBearerPreHandler(opts) }, () =>
      Promise.resolve({ ok: true }),
    );
    await app.ready();
    return app;
  }

  it('serves the protected resource metadata unauthenticated', async () => {
    const app = await appWith(() => Promise.resolve({ iss: ISSUER, aud: RESOURCE }));
    const res = await app.inject({ method: 'GET', url: RESOURCE_METADATA_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
    });
    await app.close();
  });

  it('challenges a request with no token — 401 + WWW-Authenticate to the metadata', async () => {
    const app = await appWith(() => Promise.resolve({ iss: ISSUER, aud: RESOURCE }));
    const res = await app.inject({ method: 'POST', url: '/guarded' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      'Bearer resource_metadata="https://music-importer.jake.cafe/.well-known/oauth-protected-resource"',
    );
    expect(res.json()).toEqual({ error: 'MissingToken' });
    await app.close();
  });

  it('challenges a token that fails validation and never runs the handler', async () => {
    const app = await appWith(() => Promise.reject(new Error('nope')));
    const res = await app.inject({
      method: 'POST',
      url: '/guarded',
      headers: { authorization: 'Bearer bad' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'InvalidToken' });
    await app.close();
  });

  it('passes a valid, correctly-audienced token through to the handler', async () => {
    const app = await appWith(() => Promise.resolve({ iss: ISSUER, aud: RESOURCE }));
    const res = await app.inject({
      method: 'POST',
      url: '/guarded',
      headers: { authorization: 'Bearer good' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
