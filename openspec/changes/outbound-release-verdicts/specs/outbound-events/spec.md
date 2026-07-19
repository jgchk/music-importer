## ADDED Requirements

### Requirement: Release verdicts are published as signed webhook events from the event store

The system SHALL publish `release.verdict` events to configured subscriber URLs by consuming its own event stream as the outbox: a checkpointed publisher SHALL deliver each recorded release verdict at-least-once, in order per subscriber, with per-subscriber checkpoints so one slow or unreachable subscriber does not affect another. Each delivery SHALL use the Standard Webhooks conventions: a `{type, timestamp, data}` envelope, a `webhook-id` stable across redeliveries of the same event to the same subscriber, a delivery-time `webhook-timestamp`, and a `webhook-signature` HMAC computed with the configured shared secret over the identifier, timestamp, and raw body. The payload SHALL carry the originating acquisition id, the delivered candidate's identity, the rejected verdict, and the reviewer's reasons. A delivery that exhausts its bounded retries SHALL hold the subscriber's checkpoint for redelivery rather than being lost.

#### Scenario: A recorded verdict reaches the subscriber

- **GIVEN** a configured subscriber and a review resolved with reject-and-retry-download
- **WHEN** the publisher consumes the recorded verdict
- **THEN** the subscriber receives a signed `release.verdict` delivery carrying the acquisition id, candidate identity, and reasons

#### Scenario: An unreachable subscriber loses nothing

- **GIVEN** a subscriber that is down when a verdict is recorded
- **WHEN** delivery retries are exhausted
- **THEN** the subscriber's checkpoint holds and the delivery repeats later with the same `webhook-id`, so the receiver can deduplicate

#### Scenario: Unconfigured means dormant

- **GIVEN** no subscriber URLs are configured
- **WHEN** the system runs and verdicts are recorded
- **THEN** no delivery is attempted and behavior is otherwise unchanged

#### Scenario: URLs without a secret fail loudly

- **GIVEN** subscriber URLs configured without a signing secret
- **WHEN** the system boots
- **THEN** startup fails with a configuration error naming the missing secret

### Requirement: The published event contract is producer-owned and additive-only

The system SHALL own the schema of the events it publishes: the `release.verdict` payload SHALL be defined in a single contract schema from which a JSON Schema document is generated and committed, outbound payloads SHALL be validated against it before delivery, and recorded fixtures of published events SHALL be kept permanently. A contract gate SHALL fail the build on any non-additive schema change; a breaking payload change SHALL be expressed as a new event type instead.

#### Scenario: A non-additive schema change fails the gate

- **GIVEN** a modification that removes or retypes a published field
- **WHEN** the contract gate runs
- **THEN** the build fails, pointing at the non-additive difference

#### Scenario: Frozen fixtures pin the wire format

- **GIVEN** the permanently recorded fixture of a published `release.verdict`
- **WHEN** contract tests run
- **THEN** the current schema still accepts the recorded event exactly as published
