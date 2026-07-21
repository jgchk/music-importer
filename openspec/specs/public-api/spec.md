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
