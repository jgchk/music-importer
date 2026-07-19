## Context

The downloader's verdict receiver (its change `fulfillment-external-verdict`) is live and defines what a sender must produce: Standard Webhooks headers over the raw body, and a payload whose tolerant reader consumes `data.acquisitionId`, `data.candidate {username, path, sizeBytes?}`, `data.verdict: "rejected"`, `data.reasons?`. Its stale-guard compares the candidate identity against the one retained at fulfilment, and redelivery converges through domain guards. The cross-tool posture is settled: producer-owned schemas, no shared package, tolerant readers behind ACLs, additive-only contracts with frozen fixtures. The importer already has the outbox-shaped machinery this needs — an event store folded by checkpointed consumers — and the downloader repo holds a proven publisher implementation to mirror.

## Goals / Non-Goals

**Goals:**

- One human action ("this download is bad — get another") triggers the whole recovery: files deleted here, acquisition revived there.
- The emission is durable (survives restarts and receiver downtime) and idempotent end-to-end (the receiver dedupes by `webhook-id`; the domain converges on redelivery).
- The importer becomes a disciplined event producer: published schema, frozen fixtures, additive-only gate.

**Non-Goals:**

- No automatic verdicts (e.g. from badfiles failures at propose time): adjudication stays with the user per the review-queue philosophy; automating specific failure classes is a later, separate policy change.
- No accepted/positive verdicts (the receiver rejects unknown verdict values by design; relaxing is additive later).
- No generic notification fan-out — this is the machine-to-machine loop, not the human notification surface (`NotificationPort` remains future work).

## Decisions

### D1 — A distinct verb, not a flag on reject

`reject-and-retry-download` is its own member of the resolve-review union rather than a `{retry: true}` option on `reject`, because it has a precondition plain reject lacks (a retained candidate), a distinct consequence (an outbound fact), and distinct failure modes. The union stays honest: each verb's contract is complete in itself. In the domain it resolves exactly like reject — same `ImportRejected`, same intake deletion — plus a `ReleaseVerdictRecorded` event minted in the same decision, carrying acquisition id, candidate identity, and reasons. The publisher ships facts from the stream, so emission inherits event-store durability: crash after append, before delivery → delivered on recovery; at-least-once end-to-end.

### D2 — Mirror the downloader's publisher, scoped to one event type

The publisher is a checkpointed consumer over the event stream (the store is the outbox): per-subscriber checkpoints keyed by URL hash, in-order per subscriber, subscribers isolated, bounded retries per delivery then hold-and-redeliver on the next event or restart. Envelope `{type: "release.verdict", timestamp, data}`; headers `webhook-id` (deterministic from subscriber + global sequence — the receiver's dedupe key, stable across redeliveries), `webhook-timestamp` (delivery time), `webhook-signature` (`v1,` + base64 HMAC-SHA256 over `id.timestamp.body`, key from `whsec_` secret). Config `VERDICT_WEBHOOK_URLS` (comma-separated) + `VERDICT_WEBHOOK_SECRET`: both unset → dormant, zero behavior change; URLs without secret → fatal boot error. Naming note: the env pair intentionally matches the downloader's receiver-side name so one shared secret value wires both ends.

### D3 — The payload echoes the retained candidate; the intake reader widens to keep it

The downloader's stale-guard needs the candidate identity it fulfilled with. The `acquisition.fulfilled` tolerant reader therefore additionally reads `data.candidate` (username, path, sizeBytes — all already in the sender's published schema) and the submission records it beside the acquisition id. This stays consumer-owned and tolerant: candidate absent or malformed → the submission proceeds without it (intake must not start failing on a field only a later optional verb needs), and the resulting import simply cannot emit a verdict.

### D4 — Absent candidate degrades loudly at the verb, silently nowhere

Manual submissions, pre-change intake imports, and candidate-less deliveries have no retained candidate. For them `reject-and-retry-download` is refused with a precise, contract-shaped error naming the missing precondition — the user can still plain-reject. No half-verdict (a payload without candidate identity would be dropped by the receiver's tolerant reader anyway, or worse, mis-guarded).

### D5 — Producer contract artifacts, same discipline as the sibling

Zod schema in `src/interfaces/contracts/events/`, generated JSON Schema committed under `contracts/events/release.verdict.schema.json` with an append-only history and an additivity gate in `pnpm test:contract`/CI, permanently frozen fixtures under `test/contract/fixtures/events/`. Breaking payload change = new event type, never a mutation. The downloader may copy the frozen fixture for its consumer-side contract tests; nothing is imported across repos.

## Risks / Trade-offs

- **[Verdict for an acquisition the downloader already revived]** The receiver's stale-guard ignores it — by design; no sender-side coordination needed.
- **[Secret sprawl]** Reusing the downloader's existing `VERDICT_WEBHOOK_SECRET` value means one more stack carries it; acceptable in the SOPS-per-stack model, and rotation stays a two-file edit.
- **[User rejects-and-retries a genuinely correct download (bad match, good files)]** The acquisition burns an attempt on a re-download that may land the same files. Acceptable: budgets bound it, and the verbs' descriptions must make the distinction plain (`reject` = wrong thing to have; `reject-and-retry-download` = right thing, bad copy).

## Open Questions

- None blocking; automatic verdict policies (badfiles-triggered) deliberately deferred to their own change.
