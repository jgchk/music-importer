## ADDED Requirements

### Requirement: Beets is driven through a stateless two-verb bridge behind a port

The system SHALL drive beets exclusively through a stateless Python bridge CLI behind an outbound port: `propose` runs beets' matcher over a directory and emits candidates as JSON — each identified by its `(data_source, album_id)` pair and carrying overall distance, per-penalty breakdown, and track mapping — and `apply` performs the import for a chosen candidate by deterministic ID lookup (or as-is, or with supplied tags), firing beets' full pipeline. The bridge SHALL hold no state between invocations; the JSON boundary SHALL be schema-validated at the port and covered by contract tests over recorded bridge output; the beets version SHALL be pinned in the runtime image.

#### Scenario: Propose then apply across separate invocations

- **GIVEN** a proposal produced earlier whose chosen candidate is identified by source and album ID
- **WHEN** apply runs in a fresh invocation, possibly much later
- **THEN** the candidate is re-resolved by direct ID lookup and the import applies with current metadata

#### Scenario: Contract drift is caught at the boundary

- **GIVEN** a bridge whose output no longer matches the recorded contract (e.g., after a beets upgrade)
- **WHEN** the port validates the payload
- **THEN** the mismatch surfaces as an infrastructure error, never as silent misbehavior

### Requirement: The user's beets config is authoritative, with forced non-interactive session overrides

The bridge SHALL load the user's own beets configuration (path injectable) so library-defining behavior — directory, database, path formats, the plugin chain — is identical to manual CLI use, and SHALL unconditionally override a small documented set of session keys so no invocation can ever prompt, resume, or skip incrementally, regardless of what the config requests. The service SHALL validate the configuration at startup and fail loudly on an unusable one, and SHALL expose the effective merged configuration for inspection.

#### Scenario: Library behavior matches manual CLI use

- **GIVEN** a user config with custom path formats and plugins
- **WHEN** the bridge imports a release
- **THEN** the release is filed and enriched exactly as a manual `beet import` would have

#### Scenario: An interactive config cannot hang the service

- **GIVEN** a user config that enables interactive behavior
- **WHEN** the bridge runs any verb
- **THEN** the session completes without prompting

### Requirement: Bridge invocations are serialized

The system SHALL run at most one bridge invocation at a time, so the beets SQLite database only ever sees one service-side writer; a database-busy failure SHALL surface as a retryable effect failure, never as a corrupted or half-applied import.

#### Scenario: Concurrent submissions queue

- **GIVEN** two imports submitted at once
- **WHEN** their proposals run
- **THEN** they execute one after the other and both complete normally
