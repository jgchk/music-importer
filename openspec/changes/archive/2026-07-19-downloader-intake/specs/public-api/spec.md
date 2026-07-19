## ADDED Requirements

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
