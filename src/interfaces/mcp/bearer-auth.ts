import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JWTPayload } from 'jose';
import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';

/**
 * The MCP endpoint as an OAuth 2.1 Resource Server (MCP `2025-06-18` authorization spec). A thin,
 * config-dormant edge over the untouched `/mcp` handler: it publishes RFC 9728 Protected Resource
 * Metadata so a client can discover the authorization server, and enforces a bearer token whose
 * signature, issuer, expiry, and audience (RFC 8707 resource binding) mark it as issued for THIS
 * resource. The cryptographic signature/expiry check is an injected `JwsVerifier` (jose, in the
 * composition root); the issuer/audience decisions and the HTTP challenge are the pure, fully
 * tested logic here. Validation failures are values (neverthrow), mapped to a 401 challenge.
 */

/** The RFC 9728 well-known location, served on the resource's own origin. */
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/** The RFC 9728 Protected Resource Metadata document. */
export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly bearer_methods_supported: readonly string[];
}

/** Verify a token's signature and time claims, resolving its decoded claims or rejecting. */
export type JwsVerifier = (token: string) => Promise<JWTPayload>;

export type BearerAuthError = 'MissingToken' | 'InvalidToken';

/** A Fastify preHandler guarding a route: sends a 401 challenge, or returns to let it proceed. */
export type McpPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** What the resource server needs to validate and advertise: its issuer, resource, and verifier. */
export interface McpAuthOptions {
  readonly issuer: string;
  readonly resource: string;
  readonly verify: JwsVerifier;
}

export function protectedResourceMetadata(
  issuer: string,
  resource: string,
): ProtectedResourceMetadata {
  return { resource, authorization_servers: [issuer], bearer_methods_supported: ['header'] };
}

/** The RFC 9728 §5.1 challenge URL: the metadata path anchored on the resource's origin. */
export function resourceMetadataUrl(resource: string): string {
  return new URL(RESOURCE_METADATA_PATH, resource).href;
}

/** Pull the credential out of an `Authorization: Bearer <token>` header (scheme case-insensitive). */
export function bearerTokenOf(header: string | undefined): Result<string, 'MissingToken'> {
  if (header === undefined) return err('MissingToken');
  const parts = header.trim().split(' ');
  const scheme = parts[0];
  if (scheme === undefined || scheme.toLowerCase() !== 'bearer') return err('MissingToken');
  const token = parts.slice(1).join(' ').trim();
  if (token === '') return err('MissingToken');
  return ok(token);
}

/** True if the claim value carries the resource (a string equal to it, or an array containing it). */
function carries(value: unknown, resource: string): boolean {
  if (typeof value === 'string') return value === resource;
  if (Array.isArray(value)) return value.includes(resource);
  return false;
}

/**
 * The token binds to this resource server: `iss` is the configured issuer, and the resource
 * identifier appears in the token's audience — `aud`, or (RFC 8707, defensively) `resource`/`azp`.
 */
export function claimsSatisfy(
  payload: JWTPayload,
  expected: { readonly issuer: string; readonly resource: string },
): boolean {
  if (payload.iss !== expected.issuer) return false;
  return (
    carries(payload.aud, expected.resource) ||
    carries(payload['resource'], expected.resource) ||
    carries(payload['azp'], expected.resource)
  );
}

/** Extract, cryptographically verify, and resource-bind the bearer token; failures are values. */
export async function verifyBearer(
  options: McpAuthOptions,
  header: string | undefined,
): Promise<Result<JWTPayload, BearerAuthError>> {
  const token = bearerTokenOf(header);
  if (token.isErr()) return err('MissingToken');
  let payload: JWTPayload;
  try {
    payload = await options.verify(token.value);
  } catch {
    return err('InvalidToken');
  }
  if (!claimsSatisfy(payload, options)) return err('InvalidToken');
  return ok(payload);
}

/** Register the unauthenticated RFC 9728 metadata route (hidden from the OpenAPI document). */
export function registerMcpAuth(app: FastifyInstance, options: McpAuthOptions): void {
  app.get(RESOURCE_METADATA_PATH, { schema: { hide: true } }, () =>
    protectedResourceMetadata(options.issuer, options.resource),
  );
}

/**
 * The Fastify preHandler guarding the MCP route: on a missing/invalid token it answers 401 with the
 * RFC 9728 §5.1 `WWW-Authenticate` challenge (short-circuiting the MCP handler); on success it
 * returns without sending, so the request proceeds to the unchanged handler.
 */
export function mcpBearerPreHandler(options: McpAuthOptions): McpPreHandler {
  const challenge = `Bearer resource_metadata="${resourceMetadataUrl(options.resource)}"`;
  return async (request, reply) => {
    const result = await verifyBearer(options, request.headers.authorization);
    if (result.isErr()) {
      await reply.header('WWW-Authenticate', challenge).code(401).send({ error: result.error });
    }
  };
}
