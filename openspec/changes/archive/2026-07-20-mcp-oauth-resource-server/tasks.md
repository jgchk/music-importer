## 1. Dependency

- [x] 1.1 Add `jose` to `package.json` dependencies (JWT verification via `createRemoteJWKSet` + `jwtVerify`).

## 2. Configuration + composition

- [x] 2.1 Failing tests, then implementation: `OAUTH_ISSUER` / `OAUTH_RESOURCE` / `OAUTH_JWKS_URI` in `loadConfig`, via an `oauthOf` helper surfaced as an optional `oauth` config group — issuer absent → dormant (`undefined`); issuer set with no resource → precise config error; issuer/resource/jwks-uri that are not parseable URLs → precise config errors.
- [x] 2.2 Composition root: build the jose-backed `JwsVerifier` (derive `jwks_uri` from the issuer's OIDC discovery document, or use `OAUTH_JWKS_URI`; `createRemoteJWKSet` + `jwtVerify` for signature + `exp`/`nbf`), wire the `oauth` option into `buildHttpApp`, and log the resource server active vs dormant at startup.

## 3. The bearer edge (pure + Fastify wiring)

- [x] 3.1 Failing tests, then implementation: `src/interfaces/mcp/bearer-auth.ts` — `protectedResourceMetadata(issuer, resource)` (RFC 9728 body), `bearerTokenOf(header)` (require the `Bearer <token>` scheme; else `MissingToken`), `claimsSatisfy(payload, { issuer, resource })` (`iss` === issuer AND the resource appears in `aud`/`resource`/`azp` per RFC 8707), and `verifyBearer({ verify, issuer, resource }, header)` composing them into a `Result<JWTPayload, 'MissingToken' | 'InvalidToken'>` (verifier rejection → `InvalidToken`).
- [x] 3.2 Failing tests, then implementation: `registerMcpAuth(app, options)` — the unauthenticated `GET /.well-known/oauth-protected-resource` route (hidden from OpenAPI) and the bearer preHandler that, on failure, answers `401` with `WWW-Authenticate: Bearer resource_metadata="<resource origin>/.well-known/oauth-protected-resource"` and an `{ error }` body; on success lets the request through.

## 4. Wiring the guard onto /mcp

- [x] 4.1 Failing tests, then implementation: `registerMcpEndpoint` accepts an optional `preHandler` and attaches it to `POST /mcp` (absent → the route is unguarded, exactly as today).
- [x] 4.2 Failing tests, then implementation: `buildHttpApp` gains an optional `oauth` option; when present it registers `registerMcpAuth` and passes the bearer preHandler to `registerMcpEndpoint`; when absent, nothing changes (dormant). Cover: no-oauth `/mcp` stays open; configured `/mcp` 401s without a token (with the `WWW-Authenticate` header) and passes with a valid token; the well-known route returns the metadata only when configured.

## 5. Gate + docs

- [x] 5.1 `pnpm check` fully green (format, lint incl. boundaries, typecheck, build, 100% coverage, contract, release tests).
- [x] 5.2 `.env.example` + README: the three env vars, the resource identifier, the well-known path, and the activation surface (issuer + resource values, required token audience) — note it ships dormant.
