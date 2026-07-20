## Context

The MCP `2025-06-18` authorization spec makes an MCP server an OAuth 2.1 **Resource Server**: it does not issue tokens (Keycloak does), it *validates* them. Three obligations fall on us — (1) publish OAuth 2.0 Protected Resource Metadata (RFC 9728) so a client can discover the authorization server; (2) validate presented access tokens as a resource server, including that the token's audience is *this* server (RFC 8707 Resource Indicators); (3) on an unauthorized request, return `401` with a `WWW-Authenticate` header naming the resource metadata URL (RFC 9728 §5.1).

The Authorization Server is already live: Keycloak realm `homelab` at `https://auth.jake.cafe/realms/homelab`, OIDC discovery at `.../.well-known/openid-configuration`, JWKS at `.../protocol/openid-connect/certs`. The sibling music-downloader implements the same design in parallel; env var names, metadata shape, header format, and validation rules are identical across both so one connector config authenticates to both.

This ships dormant. No deployment sets the issuer yet; the change is correct-when-activated, and until then `/mcp` is byte-for-byte the current open endpoint.

## Goals / Non-Goals

**Goals:**

- Be a spec-correct OAuth 2.1 Resource Server for `/mcp`: RFC 9728 metadata + `WWW-Authenticate`, RFC 8707 audience binding, JOSE signature/issuer/expiry validation against the live Keycloak JWKS.
- Config-dormant by default: no issuer ⇒ no new routes, no enforcement, zero behavior change — identical to today.
- Fail loud on half-configuration (issuer without resource) at boot, never at first request.
- Keep it a thin edge over the untouched MCP handler; model validation failures as typed values, not exceptions.
- Match the sibling downloader exactly so both services accept the same tokens.

**Non-Goals:**

- No Authorization Server (Keycloak already exists), no dynamic client registration, no token issuance.
- No per-tool scopes or fine-grained authorization — enforcement is all-or-nothing at the endpoint.
- No activation on any deployment in this change (a later, separate step).

## Decisions

### D1 — Config-gated on `OAUTH_ISSUER`; resource required when issuer is set

`OAUTH_ISSUER` is the single activation switch. Absent → the whole feature is dormant: `buildHttpApp` receives no `oauth` option, so neither the well-known route nor the bearer preHandler is registered, and `/mcp` stays open exactly as today. Present → `OAUTH_RESOURCE` is **required** (a resource server with no canonical identifier cannot validate audience — booting half-configured would silently accept every token; instead it is fatal at boot, the same fail-loud pattern the webhook secrets already use). `OAUTH_RESOURCE` is this server's canonical resource identifier and equals its public MCP URL: `https://music-importer.jake.cafe/mcp`. Both are validated as parseable URLs. An optional `OAUTH_JWKS_URI` lets an operator pin the JWKS endpoint directly; absent, the composition root fetches the issuer's OIDC discovery document once at startup and reads `jwks_uri` from it. Config surfaces as an optional `oauth` group on `AppConfig`.

### D2 — Protected Resource Metadata (RFC 9728) at a fixed well-known path

When configured, register `GET /.well-known/oauth-protected-resource` returning exactly:

```json
{
  "resource": "<OAUTH_RESOURCE>",
  "authorization_servers": ["<OAUTH_ISSUER>"],
  "bearer_methods_supported": ["header"]
}
```

`resource` is the canonical identifier; `authorization_servers` names Keycloak (the client picks it per RFC 9728 §7.6); `bearer_methods_supported: ["header"]` states we accept the token only in the `Authorization` header. The route is unauthenticated (discovery must precede having a token) and hidden from the OpenAPI document — it is a protocol surface, not part of the versioned `/api/v1` contract. It is served at the host-root well-known path (not under `/mcp`), matching what the `WWW-Authenticate` challenge advertises.

### D3 — Bearer enforcement as a preHandler on `/mcp`, only when configured

`registerMcpEndpoint` gains an optional `preHandler` that Fastify runs before the MCP handler on `POST /mcp`. When `oauth` is configured, `buildHttpApp` passes a bearer guard; otherwise no guard is attached and the handler runs unguarded (dormant). The guard: read `Authorization`, require a `Bearer <token>` scheme, verify the token, and on any failure short-circuit with `401` (a preHandler that sends a reply prevents the handler from running). On success it does nothing and the MCP handler proceeds untouched — MCP tool behavior is never altered. `GET`/`DELETE` on `/mcp` remain the stateless 405s and are not guarded (they carry no session and expose nothing).

### D4 — Token validation: JOSE signature + issuer + expiry, then RFC 8707 audience

Validation splits into an I/O edge and a pure core so the security-relevant logic is fully unit-tested without a network:

- **Injected verifier (`JwsVerifier`)** — built in the composition root from `jose`: `createRemoteJWKSet(new URL(jwksUri))` + `jwtVerify`, which checks the RS256 signature against the cached JWKS and the `exp`/`nbf` time claims, and returns the decoded claims (or rejects). jose caches keys and refetches on rotation (a new `kid`), so Keycloak key rollover needs no redeploy. This edge lives in the composition root (excluded from unit coverage, exercised only when activated), consistent with how all outbound I/O wiring is handled here.
- **Pure claim checks** — over the decoded claims: `iss` MUST equal `OAUTH_ISSUER`, and the **audience MUST include `OAUTH_RESOURCE`**. Per RFC 8707, the resource may appear as `aud` (string or array) or, defensively, as `resource`/`azp`; the check accepts the resource in any of these. All of this is a pure function, fully unit-tested.

`verifyBearer` composes them: extract the token (missing/malformed scheme → `MissingToken`), `await verify(token)` in a try/catch (rejection → `InvalidToken`), then the pure claim check (mismatch → `InvalidToken`). Both error kinds map to `401`; the distinction is internal (never leaked in the body). Success carries the verified claims forward (available for future per-principal logging), but no claim other than issuer/audience gates access in this change.

### D5 — The `WWW-Authenticate` challenge points at the metadata (RFC 9728 §5.1)

Every 401 from the guard sets:

```
WWW-Authenticate: Bearer resource_metadata="<public base>/.well-known/oauth-protected-resource"
```

The public base is the **origin of `OAUTH_RESOURCE`** — for resource `https://music-importer.jake.cafe/mcp` the challenge URL is `https://music-importer.jake.cafe/.well-known/oauth-protected-resource` (derived as `new URL('/.well-known/oauth-protected-resource', OAUTH_RESOURCE).href`, so no separate public-base variable is needed). A spec-compliant MCP client parses this, fetches the metadata, discovers Keycloak, obtains a token for the `resource`, and retries. The 401 body stays the existing `{ error }` idiom; the header is the machine-readable channel.

### D6 — Dormant is the untouched status quo

With no issuer: no well-known route (a request to it 404s like any unknown path), no preHandler, and `POST /mcp` accepts unauthenticated JSON-RPC exactly as before. Startup logs the resource server as active (with resource + issuer) or dormant, mirroring the receiver/publisher log lines. This is what deploys to flight in this change — an MCP `initialize` still returns 200 with no token.

## Risks / Trade-offs

- **[Half-configuration silently accepting all tokens]** An issuer with no resource could validate signature/issuer but never bind audience. → Made impossible: issuer-without-resource is fatal at boot.
- **[Startup coupling to Keycloak discovery]** Deriving `jwks_uri` fetches discovery at boot; if Keycloak is down the fetch fails. → Only when *activated* (dormant deploys never fetch); `OAUTH_JWKS_URI` is the escape hatch to skip discovery, and jose's lazy JWKS fetch tolerates transient JWKS unavailability after the URI is known.
- **[Audience shape mismatch with Keycloak]** Keycloak must emit the resource in the token audience; by default access tokens carry client-centric `aud`. → The validator accepts `aud`/`resource`/`azp`, and activation includes configuring Keycloak's audience mapper to add `OAUTH_RESOURCE` to `aud`. The exact required claims are documented for that wiring.
- **[Untested I/O edge]** The jose/discovery glue in the composition root is not unit-covered. → Consistent with the existing composition boundary; the pure, security-relevant logic (token extraction, issuer/audience checks, 401 mapping, header, metadata body, dormant-vs-active registration) is fully unit-tested behind an injected verifier.

## Open Questions

- Whether to later add per-tool scopes (e.g. a read-only connector). Deferred; the endpoint is all-or-nothing for now.
