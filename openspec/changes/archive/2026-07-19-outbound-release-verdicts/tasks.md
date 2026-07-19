## 1. Domain: the verdict fact and retained candidate

- [x] 1.1 Failing tests, then implementation: submission source gains the delivered candidate's identity (`{username, path, sizeBytes?}`, optional); `ImportRequested` records it; fold retains it on state; legacy events without it fold to no retained candidate.
- [x] 1.2 Failing tests, then implementation: `decide` on resolve-review with `reject-and-retry-download` — with a retained candidate → the existing rejection outcome plus `ReleaseVerdictRecorded` (acquisition id, candidate, reasons) in the same decision; without one → a precise refusal; settled reviews → existing no-op; plain `reject` byte-identical to today. `react`/interpreter totality extended (the verdict event drives no effect — the publisher consumes it).

## 2. Intake: read and thread the candidate

- [x] 2.1 Failing tests, then implementation: the `acquisition.fulfilled` tolerant reader also reads `data.candidate` (tolerant — absent/malformed → submission proceeds without it); the intake route threads it into the native submission; contract test against the frozen sender fixture proves the candidate extracts from the real recorded event.

## 3. The publisher (outbound-events)

- [x] 3.1 Failing tests, then implementation: producer-owned `release.verdict` contract in `src/interfaces/contracts/events/` (zod schema + stream-event → envelope mapping); generated JSON Schema committed under `contracts/events/` with append-only history; additivity gate + permanently frozen fixtures wired into `pnpm test:contract` and `check`/CI (mirror the downloader's tooling).
- [x] 3.2 Failing tests, then implementation: checkpointed publisher consumer + HTTP sender (per-subscriber checkpoints by URL hash, deterministic `webhook-id` from subscriber + global seq, Standard Webhooks signing over `id.timestamp.body`, bounded retries then hold-and-redeliver, subscriber isolation), adapted from the downloader's implementation with its test shapes.
- [x] 3.3 Composition + config: `VERDICT_WEBHOOK_URLS` (comma-separated) + `VERDICT_WEBHOOK_SECRET` (`whsec_` format validated); both unset → dormant with a startup log line; URLs without secret → fatal boot error; failing config tests first.

## 4. Public surface

- [x] 4.1 Failing tests, then implementation: resolve-review contract union gains `reject-and-retry-download {reasons?}`; HTTP + MCP wired from the same schemas; the missing-candidate refusal surfaces as the documented error shape on both; OpenAPI snapshot updated additively.

## 5. E2E + gate

- [x] 5.1 Extend the out-of-process e2e: a webhook-submitted import (candidate carried) resolved with reject-and-retry-download → intake files deleted AND a signed `release.verdict` delivery arrives at a stub subscriber with a verifiable signature and the retained candidate; a manual import's retry verb refusal; dormant config → no delivery.
- [x] 5.2 `pnpm check` + `pnpm test:e2e` fully green; doc comments faithful; README/.env.example document the new env pair (note: deploy wires the secret to the downloader's existing `VERDICT_WEBHOOK_SECRET` value).
