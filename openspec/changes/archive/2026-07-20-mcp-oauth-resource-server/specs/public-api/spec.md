## ADDED Requirements

### Requirement: The MCP endpoint is an OAuth 2.1 Resource Server, config-dormant

The system SHALL be able to protect the MCP endpoint (`POST /mcp`) as an OAuth 2.1 Resource Server per the MCP `2025-06-18` authorization spec, gated entirely on an `OAUTH_ISSUER` environment variable. Absent `OAUTH_ISSUER`, the feature SHALL be dormant: no protected-resource-metadata route is registered, no bearer enforcement runs, and `POST /mcp` SHALL behave exactly as an unauthenticated endpoint (startup logging states active vs dormant). When `OAUTH_ISSUER` is set, `OAUTH_RESOURCE` — this server's canonical resource identifier (its public MCP URL) — SHALL be required, and a missing resource or any unparseable issuer/resource/JWKS URL SHALL abort startup.

When configured, the system SHALL expose an unauthenticated `GET /.well-known/oauth-protected-resource` (RFC 9728), hidden from the OpenAPI document, returning `{ "resource": "<OAUTH_RESOURCE>", "authorization_servers": ["<OAUTH_ISSUER>"], "bearer_methods_supported": ["header"] }`. When configured, `POST /mcp` SHALL require an `Authorization: Bearer <jwt>` credential and validate it as a resource server: the RS256 signature against the issuer's JWKS (discovered from the issuer's OIDC document or an explicit `OAUTH_JWKS_URI`, cached and tolerant of key rotation), `iss` equal to `OAUTH_ISSUER`, the `exp`/`nbf` time claims, and an audience — `aud` or, per RFC 8707, `resource`/`azp` — that includes `OAUTH_RESOURCE`. A missing, malformed, invalid, expired, or wrong-audience token SHALL be refused with `401` carrying `WWW-Authenticate: Bearer resource_metadata="<resource origin>/.well-known/oauth-protected-resource"` (RFC 9728 §5.1), and validation failures SHALL be modeled as typed values, not thrown. A valid token SHALL let the request through to the unchanged MCP handler; MCP tool behavior SHALL NOT change.

#### Scenario: Dormant without an issuer

- **GIVEN** a deployment with no `OAUTH_ISSUER`
- **WHEN** an MCP client initializes over `POST /mcp` with no credential
- **THEN** the handshake succeeds unauthenticated, `GET /.well-known/oauth-protected-resource` is not registered (404), and startup logging recorded the resource server as dormant

#### Scenario: Issuer without resource is fatal at boot

- **GIVEN** `OAUTH_ISSUER` is set but `OAUTH_RESOURCE` is not
- **WHEN** the service starts
- **THEN** startup aborts with a precise configuration error naming the missing resource

#### Scenario: Protected resource metadata is published when configured

- **GIVEN** a configured resource server
- **WHEN** `GET /.well-known/oauth-protected-resource` is requested with no credential
- **THEN** the response is `200` with `resource` = `OAUTH_RESOURCE`, `authorization_servers` = `[OAUTH_ISSUER]`, and `bearer_methods_supported` = `["header"]`

#### Scenario: A missing or invalid token is challenged

- **GIVEN** a configured resource server
- **WHEN** `POST /mcp` arrives with no bearer token, or a token whose signature, issuer, expiry, or audience does not validate
- **THEN** the response is `401` with `WWW-Authenticate: Bearer resource_metadata="<resource origin>/.well-known/oauth-protected-resource"` and the MCP handler never runs

#### Scenario: A token bound to this resource is accepted

- **GIVEN** a configured resource server and a JWT signed by the issuer, unexpired, with `iss` = `OAUTH_ISSUER` and an audience including `OAUTH_RESOURCE`
- **WHEN** it is presented as `Authorization: Bearer <jwt>` on `POST /mcp`
- **THEN** the token validates and the MCP request proceeds unchanged
