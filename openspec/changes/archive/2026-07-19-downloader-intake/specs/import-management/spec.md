## ADDED Requirements

### Requirement: A fulfilled acquisition submits an import idempotently through the native path

The system SHALL translate an accepted `acquisition.fulfilled` delivery into the same native submission the manual API uses: the sender's `location` re-rooted from the configured source root (`INTAKE_SOURCE_ROOT`) onto the intake root, with the event's MusicBrainz release id (when present) passed as the pinning hint and the target's artist/title as auxiliary hints. The acquisition id SHALL be recorded on the resulting `ImportRequested` event, and redelivery of an already-recorded acquisition SHALL converge as an acknowledged no-op — durably, across restarts, without creating a duplicate import. A delivery whose location falls outside the source root SHALL be rejected; a delivery whose re-rooted directory does not exist SHALL be answered with a retryable infrastructure failure (never a silent acknowledgement), so the sender's at-least-once retry redelivers once the files are visible.

#### Scenario: A fulfilled download flows into the import lifecycle

- **GIVEN** the receiver is active and the downloader deposited a release visible under the intake root
- **WHEN** its signed `acquisition.fulfilled` event is delivered
- **THEN** an import is submitted for the re-rooted directory with the event's MusicBrainz release id as the search hint
- **AND** the import proceeds through the normal propose → auto-apply/review lifecycle

#### Scenario: Redelivery converges without a duplicate import — even after the import applied

- **GIVEN** an acquisition whose earlier delivery already submitted an import that has since applied (the intake directory is gone)
- **WHEN** the same event is redelivered after a service restart
- **THEN** the delivery is acknowledged as a converged no-op
- **AND** no second import exists

#### Scenario: A not-yet-visible directory defers to the sender's retry

- **GIVEN** a delivery whose re-rooted directory does not exist on the importer's filesystem
- **WHEN** it is received
- **THEN** the response is an infrastructure-flavored failure, not an acknowledgement
- **AND** a later redelivery, after the files appear, submits the import

#### Scenario: A location outside the source root is rejected

- **GIVEN** a delivery whose `location` does not fall under the configured source root
- **WHEN** it is received
- **THEN** it is rejected without touching the filesystem or submitting an import
