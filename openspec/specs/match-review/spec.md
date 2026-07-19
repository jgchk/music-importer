# match-review Specification

## Purpose

Define the typed review queue for imports awaiting human action: the review kinds and their carried context, the explicit resolution verbs, idempotent resolution semantics, and rejection's intake-hygiene guarantee.

## Requirements

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

The system SHALL resolve review items through explicit verbs: apply a listed candidate, supply a MusicBrainz ID (pinned re-propose), refresh the candidate list, apply a full manual tag payload (per-track fields with an explicit track mapping; beets applies them with autotagging bypassed, plugins still firing), import as-is, reject, and reject-and-retry-download. Rejecting SHALL delete the release's files from the intake directory. Reject-and-retry-download SHALL do everything reject does and SHALL additionally record a release verdict — the fact that the delivered release failed external validation — carrying the originating acquisition id, the delivered candidate's identity, and the reviewer's reasons; it SHALL be available only for imports that retain a delivered candidate's identity, and SHALL otherwise be refused with an error naming the missing precondition while plain reject remains available. Resolving an already-settled review SHALL be a tolerated no-op.

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

#### Scenario: Reject-and-retry-download records the verdict beside the rejection

- **GIVEN** a review for an import that arrived from the downloader with a retained candidate
- **WHEN** the user resolves it with reject-and-retry-download and reasons
- **THEN** the files are removed from intake, the import is terminal `rejected`, and a release verdict is recorded carrying the acquisition id, the retained candidate identity, and the reasons

#### Scenario: The retry verb is refused without a retained candidate

- **GIVEN** a review for a manually submitted import, or one recorded before candidate retention existed
- **WHEN** reject-and-retry-download is attempted
- **THEN** it is refused with an error naming the missing retained candidate
- **AND** plain reject still resolves the review normally

#### Scenario: A redelivered resolution converges

- **GIVEN** a review already resolved
- **WHEN** the same resolution is delivered again
- **THEN** nothing changes and no error is raised
