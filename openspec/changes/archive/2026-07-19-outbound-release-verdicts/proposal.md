## Why

The bad-download feedback loop is half-built: music-downloader ships a signed verdict receiver (`POST /api/v1/webhooks/verdicts`, v2.4.0) that revives a fulfilled acquisition into its retry ladder when the delivered release is rejected — but nothing sends verdicts. Today a corrupt or mislabeled rip means rejecting the import here and then manually poking the downloader (or hand-signing a curl). The importer is the system that *adjudicates* delivered releases; it should publish that adjudication so a bad rip in becomes a better rip out, hands-free.

## What Changes

- A new review verb, **`reject-and-retry-download`**: everything plain `reject` does (files deleted from intake, import terminal `rejected`) plus a recorded release verdict — the fact that the delivered release failed external validation, carrying the originating acquisition id, the delivered candidate's identity, and the reviewer's reasons. Available only for imports that arrived via downloader intake with a retained candidate; plain `reject` is unchanged and remains the verb for "just delete this."
- A new **`outbound-events` capability** mirroring the downloader's posture: the event store is the outbox; a checkpointed publisher consumer delivers `release.verdict` events to configured subscriber URLs with Standard Webhooks envelope + HMAC signing (`VERDICT_WEBHOOK_URLS` / `VERDICT_WEBHOOK_SECRET`), at-least-once, per-subscriber checkpoints, config-dormant when unset, fail-loud when URLs are set without a secret.
- **Producer-owned contract artifacts**: zod schema for `release.verdict`, generated JSON Schema committed with an additive-only diff gate, permanently frozen fixtures — the same discipline the downloader applies to `acquisition.fulfilled`, now on this repo's emitting side. The payload shape is chosen to satisfy the downloader's published tolerant-reader needs (acquisition id, candidate `{username, path, sizeBytes}`, verdict `rejected`, reasons).
- **Intake retains the candidate**: the `acquisition.fulfilled` tolerant reader additionally reads `data.candidate` and records it on the submission, so a later verdict can echo the identity the downloader's stale-guard requires. Imports recorded before this change (or submitted manually) have no candidate — for them the new verb is unavailable, reported as such.

## Capabilities

### New Capabilities

- `outbound-events`: the importer's outbound webhook publisher — event store as outbox, checkpointed per-subscriber delivery, Standard Webhooks signing, producer-owned schema/fixture/gate artifacts, config-dormant.

### Modified Capabilities

- `match-review`: the verb set gains `reject-and-retry-download` (reject + recorded release verdict; candidate-retention precondition and its graceful absence).
- `import-management`: downloader-intake submissions additionally record the delivered candidate's identity from the event.
- `public-api`: the resolve-review request union gains the new verb, including its unavailable-precondition error shape.

## Impact

- `src/domain/import/` — `ReleaseVerdictRecorded` event (fact minted alongside the rejection when the verb is used); candidate identity on the submission source.
- `src/interfaces/contracts/intake/` — tolerant reader widened to `data.candidate`; `src/interfaces/contracts/events/` — new producer-owned `release.verdict` schema + mapping; `contracts/events/` — generated JSON Schema + history; `test/contract/` — frozen fixtures + additivity gate wired into `pnpm check`/CI.
- `src/application`/`src/adapters` — publisher consumer + HTTP sender with retry/backoff (mirrors the downloader's, adapted); composition/config for `VERDICT_WEBHOOK_URLS`/`VERDICT_WEBHOOK_SECRET`.
- `src/interfaces/http` + MCP — verb union extension.
- Deployment (homelab, post-merge): importer stack gains `VERDICT_WEBHOOK_URLS=http://192.168.1.238:3000/api/v1/webhooks/verdicts` and `VERDICT_WEBHOOK_SECRET` (same value as the downloader's existing receiver secret).
