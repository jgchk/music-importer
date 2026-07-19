## MODIFIED Requirements

### Requirement: Beets is driven through a stateless two-verb bridge behind a port

The system SHALL drive beets exclusively through a stateless Python bridge CLI behind an outbound port: `propose` runs beets' matcher over a directory and emits candidates as JSON — each identified by its `(data_source, album_id)` pair and carrying overall distance, per-penalty breakdown, and track mapping — and `apply` performs the import for a chosen candidate by deterministic ID lookup (or as-is, or with supplied tags), firing beets' full pipeline. The bridge SHALL hold no state between invocations; the JSON boundary SHALL be schema-validated at the port and covered by contract tests over recorded bridge output; the beets version SHALL be pinned in the runtime image. The bridge SHALL reserve its output channel exclusively for the contract JSON: anything beets, its plugins, or their subprocesses print SHALL be diverted to the diagnostic stream and SHALL NOT corrupt the JSON boundary.

#### Scenario: Propose then apply across separate invocations

- **GIVEN** a proposal produced earlier whose chosen candidate is identified by source and album ID
- **WHEN** apply runs in a fresh invocation, possibly much later
- **THEN** the candidate is re-resolved by direct ID lookup and the import applies with current metadata

#### Scenario: Contract drift is caught at the boundary

- **GIVEN** a bridge whose output no longer matches the recorded contract (e.g., after a beets upgrade)
- **WHEN** the port validates the payload
- **THEN** the mismatch surfaces as an infrastructure error, never as silent misbehavior

#### Scenario: Plugin output cannot corrupt the contract channel

- **GIVEN** a user config whose plugin chain prints freely during load, migration, or import
- **WHEN** any bridge verb runs
- **THEN** the verb's JSON output parses cleanly and the printed noise is available on the diagnostic stream
- **AND** a successful apply is recorded as successful
