## ADDED Requirements

### Requirement: Uncertain imports wait in a typed review queue

The system SHALL expose every import awaiting human action as a review item of an explicit kind — `match-review` (weak or hint-contradicted match, carrying the candidate list with distances and per-penalty detail), `no-match` (beets found no candidates), `duplicate-review` (the album already exists in the library), or `remediation-review` (post-move enrichment failed) — with enough carried context to decide without SSH or the beets CLI.

#### Scenario: The pending queue is listable with actionable context

- **GIVEN** imports awaiting review of different kinds
- **WHEN** the pending reviews are listed
- **THEN** each item carries its kind, the submitted directory, and kind-specific context (candidates with distances, the duplicate's incumbent, or the failed enrichment step)

#### Scenario: No-match is distinguished from low confidence

- **GIVEN** a directory for which beets returns zero candidates
- **WHEN** its review item is read
- **THEN** its kind states that no candidates were found, not that confidence was low

### Requirement: Reviews resolve through explicit verbs, and rejection cleans intake

The system SHALL resolve review items through explicit verbs: apply a listed candidate, supply a MusicBrainz ID (pinned re-propose), refresh the candidate list, apply a full manual tag payload (per-track fields with an explicit track mapping; beets applies them with autotagging bypassed, plugins still firing), import as-is, and reject. Rejecting SHALL delete the release's files from the intake directory. Resolving an already-settled review SHALL be a tolerated no-op.

#### Scenario: Supplying an ID re-proposes pinned to that release

- **GIVEN** a match-review whose candidates are all wrong
- **WHEN** the user supplies a MusicBrainz release ID
- **THEN** the system re-proposes pinned to that ID and the review updates with the resulting candidate

#### Scenario: Manual tags import without autotagging

- **GIVEN** a no-match review for a release MusicBrainz will never know
- **WHEN** the user resolves it with a full tag payload
- **THEN** the files import carrying exactly the supplied tags, filed by the library's path rules

#### Scenario: Rejection leaves no residue

- **GIVEN** a review the user rejects outright
- **WHEN** the rejection is recorded
- **THEN** the release's files are removed from intake and the import is terminal `rejected`

#### Scenario: A redelivered resolution converges

- **GIVEN** a review already resolved
- **WHEN** the same resolution is delivered again
- **THEN** nothing changes and no error is raised
