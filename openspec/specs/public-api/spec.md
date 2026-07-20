# public-api Specification

## Purpose

Expose the import lifecycle over the versioned HTTP API and the MCP server from a single zod contract source, additive-only within the version, with a published OpenAPI document.
## Requirements
### Requirement: Imports and reviews are exposed over HTTP and MCP from one contract source

The system SHALL expose the import lifecycle over a versioned HTTP API (`/api/v1/imports`) and an MCP server offering the same operations: submit an import (directory path + optional hints), list imports, get an import (with its history), list pending reviews, and resolve a review by verb — the verb union including reject-and-retry-download, whose missing-precondition refusal (no retained candidate) SHALL surface as a precise, schema-shaped error on both surfaces. Both surfaces SHALL be generated from a single set of zod contract schemas, and the HTTP API SHALL publish its OpenAPI document. Changes to the public surface SHALL be additive-only within the version.

#### Scenario: Manual import end to end over HTTP

- **GIVEN** a directory of music files
- **WHEN** it is submitted over HTTP
- **THEN** the response returns an import ID and status URL, and the import proceeds through the lifecycle observable at that URL

#### Scenario: An agent resolves a review over MCP

- **GIVEN** a pending match-review
- **WHEN** an MCP client lists pending reviews and resolves one with a listed candidate
- **THEN** the resolution is the same operation the HTTP surface offers, and the import proceeds to applied

#### Scenario: Submission validation is schema-driven

- **GIVEN** a submission missing its directory path
- **WHEN** it is posted
- **THEN** it is rejected by schema validation with a precise error, identically on both surfaces

#### Scenario: The retry verb's refusal is contract-shaped on both surfaces

- **GIVEN** a review whose import retains no delivered candidate
- **WHEN** reject-and-retry-download is submitted over HTTP or MCP
- **THEN** the refusal names the missing retained-candidate precondition in the documented error shape, identically on both surfaces

### Requirement: A signed webhook receiver accepts downloader events as a tolerant reader

The system SHALL expose an inbound webhook receiver (`POST /api/v1/webhooks/acquisitions`) that verifies Standard Webhooks deliveries — `webhook-id`, `webhook-timestamp` (±300s replay window), and `webhook-signature` (`v1,` + base64 HMAC-SHA256 over `id.timestamp.rawBody` with the shared `whsec_` secret) — against the raw request bytes before any parsing, answering 401 to missing/invalid signatures or stale timestamps. The receiver SHALL be config-dormant: without `INTAKE_WEBHOOK_SECRET` the route is not registered (startup logging states active vs dormant), and a malformed secret or an active receiver missing `INTAKE_SOURCE_ROOT` SHALL abort startup. Payloads SHALL be read tolerantly through a consumer-owned schema that ignores unknown fields at every level and imports nothing from the sender's codebase; unknown event `type` values SHALL be acknowledged 2xx and ignored. After a valid signature: unreadable payloads answer 400, submissions and convergent no-ops answer 204, and infrastructure faults answer 5xx so the sender redelivers. Conformance of the tolerant reader against the sender's frozen recorded fixture SHALL be enforced by contract tests.

#### Scenario: A correctly signed delivery is accepted

- **GIVEN** an active receiver sharing a secret with the sender
- **WHEN** an `acquisition.fulfilled` delivery arrives signed over its exact raw body within the timestamp window
- **THEN** it is acknowledged 204 and the import is submitted

#### Scenario: A bad signature or stale timestamp is refused before parsing

- **GIVEN** a delivery signed with the wrong key, or replayed outside the timestamp window
- **WHEN** it arrives
- **THEN** the response is 401 and the payload is never parsed nor acted upon

#### Scenario: An unknown event type is acknowledged and ignored

- **GIVEN** a correctly signed delivery whose `type` the importer does not consume
- **WHEN** it arrives
- **THEN** it is acknowledged 2xx and no import is affected

#### Scenario: Without a configured secret the endpoint does not exist

- **GIVEN** a deployment with no `INTAKE_WEBHOOK_SECRET`
- **WHEN** anything is posted to the receiver path
- **THEN** the response is 404 and startup logging recorded the receiver as dormant

#### Scenario: The recorded sender fixture parses through the tolerant reader

- **GIVEN** the sender's frozen `acquisition.fulfilled` fixture
- **WHEN** the contract tier runs
- **THEN** the tolerant reader accepts it and extracts exactly the acquisition id, location, and hint fields the importer uses

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

