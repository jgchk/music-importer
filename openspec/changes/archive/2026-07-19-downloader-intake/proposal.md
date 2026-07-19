## Why

The download → import loop is still open: music-downloader deposits a validated release into the shared intake directory and emits an `acquisition.fulfilled` webhook — but nothing listens. Imports happen only when a human (or agent) notices the deposit and calls `POST /api/v1/imports`. The bootstrap change deliberately deferred automated intake; this change lands it, so a fulfilled download flows straight into propose → auto-apply/review with no manual step, carrying the downloader's MusicBrainz release id as the high-value search hint.

## What Changes

- A **signed inbound webhook receiver** (`POST /api/v1/webhooks/acquisitions`), verifying Standard Webhooks signatures (`webhook-id`/`webhook-timestamp`/`webhook-signature`, HMAC-SHA256 over the raw body, ±300s replay window) with a shared `whsec_` secret before any parsing. Config-dormant: without `INTAKE_WEBHOOK_SECRET` the route is not registered.
- A **tolerant reader behind the ACL** for the downloader's `acquisition.fulfilled` event: a narrow consumer-side zod schema reading only `data.acquisitionId`, `data.location`, and `data.target` (`type`, `artist`, `title`, `musicbrainzReleaseId`), ignoring unknown fields at every level; unknown event `type`s are acknowledged and ignored. No type or code is imported from the downloader repo.
- **Path re-rooting**: `data.location` names the release in the *sender's* filesystem namespace; new env `INTAKE_SOURCE_ROOT` (the sender's root prefix) is stripped and the remainder joined onto `INTAKE_ROOT`. Deliveries outside the source root are rejected; a re-rooted directory that does not exist (yet) yields an infra-flavored 503 so the sender's at-least-once retry redelivers later.
- **Durable idempotency by acquisition id**: the translated submission reuses the native submit path and records the acquisition id on `ImportRequested` (an additive optional `source` field); a projection index over the event log answers "seen this acquisition?" across restarts, so redelivery converges 204 without a duplicate import — even after the import applied and the intake directory is gone.
- **Consumer-driven contract tests**: the sender's frozen `acquisition.fulfilled` fixture (recorded by music-downloader v2.3.0, PR #44) is copied into `test/contract/fixtures/events/` and a contract test proves the tolerant reader accepts the real recorded event and extracts exactly the fields the importer uses — the cross-repo drift alarm.

Explicitly not in this change: outbound `release.verdict` events back to the downloader, a catch-up sweep over the intake directory, and any parallel intake pipeline (the receiver is a thin front door onto the existing submission use-case).

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `import-management`: event-driven submission — an acquisition-fulfilled delivery submits an import idempotently (durable by acquisition id), with the sender's location re-rooted into the importer's namespace and the MusicBrainz release id passed as the pinning hint.
- `public-api`: the signed webhook receiver — Standard Webhooks verification over the raw body, config-dormant registration, and the response taxonomy (204 acknowledged/converged, 401 signature/timestamp, 400 unreadable, 5xx infra for redelivery).

## Impact

- `src/domain/import/` — additive optional `source` (acquisition id) on `SubmitImport`/`ImportRequested`.
- `src/application/` — `submitImport` threads the source; `ImportStatusProjection` gains a rebuildable acquisition-id → import-id index and a lookup use-case.
- `src/interfaces/http/` — `webhook-verification.ts` (Standard Webhooks, mirrored from the sender's receiver conventions) + `intake-webhook.ts` (raw-body scope, verification, translation, re-rooting, submission); `src/interfaces/contracts/intake/` — the tolerant reader schema + ACL mapping.
- `src/composition/` — `INTAKE_WEBHOOK_SECRET` + `INTAKE_SOURCE_ROOT` config (validated at startup: malformed secret or a missing source root is fatal), conditional registration, active/dormant startup log.
- `test/contract/` — the frozen sender fixture + tolerant-reader contract test; `test/e2e/` — a signed-delivery scenario (submit + converge) and a wrong-signature 401.
