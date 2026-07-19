## ADDED Requirements

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
