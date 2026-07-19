## 1. Domain + application: the durable acquisition linkage

- [x] 1.1 Failing tests, then implementation: additive optional `source: { acquisitionId }` on `SubmitImport`/`ImportRequested`; `decide` stamps it onto the event; `submitImport` threads it through `SubmitImportInput`.
- [x] 1.2 Failing tests, then implementation: `ImportStatusProjection` maintains an acquisition-id → import-id index (built in `apply`, cleared on `rebuild`); a `findAcquisitionImport` use-case query exposes it.

## 2. The intake ACL: tolerant reader + re-rooting

- [x] 2.1 Failing tests, then implementation: `src/interfaces/contracts/intake/schemas.ts` — the consumer-owned tolerant zod reader for `acquisition.fulfilled` (envelope `type` dispatch; `data.acquisitionId`, `data.location`, `data.target.{type,artist,title,musicbrainzReleaseId}`; unknown fields ignored at every level; `target.type` an open string; MBID null/absent tolerated).
- [x] 2.2 Failing tests, then implementation: `src/interfaces/contracts/intake/mapping.ts` — event → native submission (MBID → `mbReleaseId` hint, artist/title → hints, title only for album targets) and `rerootLocation` (strict containment under the source root, `.`/`..`/empty-segment rejection, join onto the intake root).

## 3. The signed receiver

- [x] 3.1 Failing tests, then implementation: `src/interfaces/http/webhook-verification.ts` — Standard Webhooks verification (key decode from `whsec_`, ±300s window, timing-safe v1 HMAC comparison over the raw body), mirrored from the sibling's conventions.
- [x] 3.2 Failing tests, then implementation: `src/interfaces/http/intake-webhook.ts` — raw-body Fastify scope, verify → parse → dispatch (unknown type 204) → converge on a known acquisition (204) → re-root (400 outside root) → injected directory-existence probe (503 missing) → `submitImport` with the source (204 / 409 / 500); registered from `buildHttpApp` options; hidden from the OpenAPI document.

## 4. Configuration + composition

- [x] 4.1 Failing tests, then implementation: `INTAKE_WEBHOOK_SECRET` (optional; malformed → precise config error) and `INTAKE_SOURCE_ROOT` (required iff the secret is set) in `loadConfig`, surfaced as an optional `intakeWebhook` config group.
- [x] 4.2 Composition root: wire the receiver options (secret, source root, intake root, filesystem existence probe) into `buildHttpApp` when configured; log the receiver active vs dormant at startup.

## 5. Contract + E2E tiers

- [x] 5.1 Copy the sender's frozen fixture to `test/contract/fixtures/events/acquisition.fulfilled/v1.json` (provenance: music-downloader v2.3.0, PR #44; never regenerate) and add `test/contract/downloader-events.contract.test.ts`: the tolerant reader accepts the recorded event and extracts exactly the fields the importer uses.
- [x] 5.2 Extend `test/e2e/`: harness env (secret + source root + a webhook fixture release), a signed delivery submits the re-rooted import and a redelivery converges (one import), a wrong signature answers 401; run `pnpm test:e2e` locally.

## 6. Gate + docs

- [x] 6.1 `pnpm check` fully green (format, lint incl. boundaries, typecheck, build, 100% coverage, contract, release tests).
- [x] 6.2 README deployment notes: the new env vars, the receiver path, and the sender-side `WEBHOOK_URLS` target.
