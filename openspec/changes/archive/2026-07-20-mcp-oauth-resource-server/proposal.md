## Why

The MCP endpoint (`POST /mcp`) is currently open: anyone who can reach the port can drive imports. To let hosted MCP clients (Claude connectors) authenticate against our self-hosted Keycloak, the endpoint must become an OAuth 2.1 **Resource Server** per the MCP `2025-06-18` authorization spec — advertising its authorization server, enforcing bearer tokens, and validating that each token was issued for this exact resource. The sibling music-downloader is landing the identical shape in parallel, so both services behave the same to one connector configuration.

This change ships **config-dormant**: with no issuer configured, `/mcp` behaves exactly as today (unauthenticated, no new routes enforced). Activation — wiring Keycloak's audience mapper, nginx, and the connector — happens later and separately by setting two environment variables.

## What Changes

- **Config (config-gated on `OAUTH_ISSUER`)**: new `OAUTH_ISSUER` (the Keycloak realm issuer, e.g. `https://auth.jake.cafe/realms/homelab`) and `OAUTH_RESOURCE` (this server's canonical resource identifier = its public MCP URL, `https://music-importer.jake.cafe/mcp`). When `OAUTH_ISSUER` is set, `OAUTH_RESOURCE` is required (fatal at boot otherwise). An optional `OAUTH_JWKS_URI` overrides discovery; absent, the JWKS URI is derived from the issuer's OIDC discovery document (fetched once at startup, cached). Absent `OAUTH_ISSUER`, the feature is entirely dormant: no new routes, no enforcement, no behavior change.
- **Protected Resource Metadata (RFC 9728)**: a new unauthenticated `GET /.well-known/oauth-protected-resource` returning `{ "resource": "<OAUTH_RESOURCE>", "authorization_servers": ["<OAUTH_ISSUER>"], "bearer_methods_supported": ["header"] }`. Registered only when configured; hidden from the OpenAPI document.
- **Bearer enforcement on `/mcp`** (only when configured): a preHandler requires `Authorization: Bearer <jwt>`. The JWT is validated with `jose` (`createRemoteJWKSet` + verify): signature via the issuer's JWKS, `iss` === `OAUTH_ISSUER`, `exp`/`nbf`, and audience — `aud` (or `resource`/`azp` per RFC 8707) MUST include `OAUTH_RESOURCE`. Missing/invalid/expired/wrong-audience → `401` with `WWW-Authenticate: Bearer resource_metadata="<public base>/.well-known/oauth-protected-resource"`. Validation failures are modeled as typed values (neverthrow) and mapped to 401. The JWKS is cached and tolerates key rotation (jose refetches).
- **A thin edge**: the enforcement is a Fastify preHandler on the existing `/mcp` route plus the one well-known route. MCP tool behavior is unchanged.

Explicitly not in this change: activating auth on any deployment, the Authorization Server itself (Keycloak is already live), dynamic client registration, and any per-tool scope/authorization (all-or-nothing at the endpoint for now).

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `public-api`: the MCP endpoint as an OAuth 2.1 Resource Server — config-dormant RFC 9728 protected-resource metadata and bearer-token enforcement (JWKS signature, issuer, expiry, and RFC 8707 audience binding to the resource) on `/mcp`, with the RFC 9728 `WWW-Authenticate` challenge on 401.

## Impact

- `src/composition/config.ts` — `OAUTH_ISSUER` / `OAUTH_RESOURCE` / `OAUTH_JWKS_URI` parsing, surfaced as an optional `oauth` config group (issuer set ⇒ resource required; URLs validated; else fatal at boot).
- `src/interfaces/mcp/bearer-auth.ts` — the pure edge: bearer-header extraction, RFC 8707 audience/issuer claim checks, the `verifyBearer` Result mapping, the protected-resource-metadata body, and the Fastify preHandler + well-known route registration (over an injected verifier).
- `src/interfaces/mcp/server.ts` — `registerMcpEndpoint` accepts an optional preHandler to guard `POST /mcp`.
- `src/interfaces/http/app.ts` — when an `oauth` option is present, register the well-known route and pass the bearer preHandler to the MCP endpoint.
- `src/composition/index.ts` — build the jose-backed verifier (discovery → JWKS URI, `createRemoteJWKSet`) and log the resource server active vs dormant at startup.
- `package.json` — add `jose`.
- `.env.example` / `README.md` — the three env vars and the activation surface.
