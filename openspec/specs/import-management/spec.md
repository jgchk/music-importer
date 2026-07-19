# import-management Specification

## Purpose

Govern the event-sourced import lifecycle: idempotent submission of a directory (with optional hints), proposing candidates through the beets bridge, the auto-apply policy where distance governs, terminal outcomes, and the boundary that keeps the beets library database the system of record for library state while the event stream narrates only the import process.

## Requirements

### Requirement: An import is an event-sourced process over a submitted directory

The system SHALL model each import as an event-sourced aggregate keyed by the submitted directory, moving through `requested → proposing → awaiting-review | applying → applied | rejected`, with every transition — including each human resolution and the reason a review was required — recorded as events. The event stream SHALL narrate the import process only: the beets library database remains the system of record for library state, and the system SHALL NOT tag, move, or otherwise mutate library files outside of beets.

#### Scenario: A confident match imports without human action

- **GIVEN** a directory of files whose best candidate scores a strong match
- **WHEN** the import is submitted
- **THEN** the candidate is applied through beets and the import reaches `applied` with no human involvement
- **AND** the event history records the proposal, the winning candidate, and the applied outcome

#### Scenario: History explains a human decision

- **GIVEN** an import that required review and was resolved by choosing a candidate
- **WHEN** the import's history is read
- **THEN** it shows why review was required (the kind and carried detail) and which resolution the user chose

### Requirement: Submission is idempotent and hints aid matching without overriding it

The system SHALL accept an import submission as a directory path plus optional hints (a MusicBrainz release ID, artist/album strings). Resubmitting the same directory while its import is live SHALL NOT create a second import. Hints SHALL pin the candidate search, but match confidence SHALL still govern the verdict: a hinted candidate with a failing distance routes to review carrying the specific mismatch rather than auto-applying.

#### Scenario: A duplicate submission converges

- **GIVEN** a directory already submitted and not yet terminal
- **WHEN** the same directory is submitted again
- **THEN** the existing import is returned and no new aggregate is created

#### Scenario: A hint with a bad distance goes to review, not auto-apply

- **GIVEN** a submission hinted with a MusicBrainz release ID whose files are missing a track
- **WHEN** the proposal completes
- **THEN** the import lands in review with the hinted candidate's penalty detail (the missing track) attached
- **AND** the user may apply it anyway or reject it

### Requirement: A partial apply failure lands applied with remediation, never failed

When beets has moved files into the library but a post-move step (plugin enrichment) fails, the system SHALL record the import as `applied` and raise a remediation review item describing exactly what failed, offering acceptance or a retry of the enrichment. A failure before files move SHALL be retried as an effect failure and, if doomed, land the import `rejected` with its reason.

#### Scenario: Enrichment failure does not mask a successful import

- **GIVEN** an apply where files moved but a network-dependent plugin step failed
- **WHEN** the outcome is recorded
- **THEN** the import is `applied` and a remediation item carries the failed step
- **AND** resolving the item as accepted closes it without touching the library

### Requirement: A fulfilled acquisition submits an import idempotently through the native path

The system SHALL translate an accepted `acquisition.fulfilled` delivery into the same native submission the manual API uses: the sender's `location` re-rooted from the configured source root (`INTAKE_SOURCE_ROOT`) onto the intake root, with the event's MusicBrainz release id (when present) passed as the pinning hint and the target's artist/title as auxiliary hints. The acquisition id SHALL be recorded on the resulting `ImportRequested` event, together with the delivered candidate's identity when the event carries one — read tolerantly, so a delivery without a usable candidate still submits normally and simply yields an import that cannot emit a release verdict. Redelivery of an already-recorded acquisition SHALL converge as an acknowledged no-op — durably, across restarts, without creating a duplicate import. A delivery whose location falls outside the source root SHALL be rejected; a delivery whose re-rooted directory does not exist SHALL be answered with a retryable infrastructure failure (never a silent acknowledgement), so the sender's at-least-once retry redelivers once the files are visible.

#### Scenario: A fulfilled download flows into the import lifecycle

- **GIVEN** the receiver is active and the downloader deposited a release visible under the intake root
- **WHEN** its signed `acquisition.fulfilled` event is delivered
- **THEN** an import is submitted for the re-rooted directory with the event's MusicBrainz release id as the search hint
- **AND** the import proceeds through the normal propose → auto-apply/review lifecycle

#### Scenario: The delivered candidate's identity is retained

- **GIVEN** an `acquisition.fulfilled` delivery whose payload carries the winning candidate's identity
- **WHEN** the import is submitted
- **THEN** the candidate identity is recorded beside the acquisition id, available to a later release verdict

#### Scenario: A candidate-less delivery still imports

- **GIVEN** a delivery whose payload lacks a readable candidate
- **WHEN** the import is submitted
- **THEN** submission proceeds normally without a retained candidate

#### Scenario: Redelivery converges without a duplicate import — even after the import applied

- **GIVEN** an acquisition whose earlier delivery already submitted an import that has since applied (the intake directory is gone)
- **WHEN** the same event is redelivered after a service restart
- **THEN** the delivery is acknowledged as a converged no-op
- **AND** no second import exists

#### Scenario: A not-yet-visible directory defers to the sender's retry

- **GIVEN** a delivery whose re-rooted directory does not exist on the importer's filesystem
- **WHEN** the delivery is processed
- **THEN** it is answered with a retryable infrastructure failure so the sender redelivers later
