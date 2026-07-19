## Context

music-downloader (the sibling repo) emits producer-owned webhook events per the Standard Webhooks conventions: a `{type, timestamp, data}` JSON body, headers `webhook-id` (deterministic idempotency key), `webhook-timestamp` (unix seconds), and `webhook-signature` (`v1,` + base64 HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` with a shared `whsec_<base64>` secret). Delivery is at-least-once: anything but a 2xx is retried, including redeliveries long after a restart. The sender publishes a JSON Schema for `acquisition.fulfilled` and a frozen recorded fixture (music-downloader v2.3.0, PR #44); its `data` carries `acquisitionId`, `target` (`{type, artist, title, musicbrainzReleaseId|null, year|null, trackCount}`), `location` (an absolute release directory in the *sender's* container namespace), `files`, and `candidate`.

Both services see the same physical intake directory under different mount points: the downloader deposits under its own root (e.g. `/downloads/import/...`), the importer sees the same directories under `INTAKE_ROOT`. The bootstrap change shipped idempotent directory-keyed submission (`POST /api/v1/imports`), which this receiver reuses.

## Goals / Non-Goals

**Goals:**

- Close the loop: a fulfilled acquisition becomes a submitted import automatically, with the MusicBrainz release id (when present) pinning the proposal search.
- Never trust the network edge: signature over the raw bytes before parsing; replay window; unsigned/invalid → 401.
- Converge under at-least-once delivery — durably, across restarts, without duplicate imports.
- Stay decoupled: a tolerant consumer-side reader behind the ACL; zero imports from the downloader repo; unknown fields and unknown event types never break the receiver.

**Non-Goals:**

- No outbound events back to the downloader (the `release.verdict` loop is a follow-up).
- No catch-up sweep for deliveries lost while the importer was down and the sender exhausted its retries (follow-up; the sender's retry schedule makes this rare).
- No new import semantics: the receiver is a front door onto the existing submission use-case, not a parallel pipeline.

## Decisions

### D1 — A tolerant reader behind the ACL; the fixture is the drift alarm

The receiver defines its own narrow zod schema for `acquisition.fulfilled`, reading only what the importer uses: `data.acquisitionId`, `data.location`, and `data.target`'s `type`/`artist`/`title`/`musicbrainzReleaseId`. Every level ignores unknown fields (zod's default stripping); `target.type` is read as an open string, not an enum, so new target kinds never 4xx; `musicbrainzReleaseId` tolerates null or absent. Nothing is imported from the downloader repo — the contract is pinned instead by a consumer-driven contract test over the sender's frozen fixture (copied into `test/contract/fixtures/events/acquisition.fulfilled/v1.json`, provenance noted, never regenerated): it proves the real recorded event parses and yields exactly the submission the importer derives. The ACL maps the event to native vocabulary: `target.artist` → the artist hint, `target.title` → the album hint (only when `target.type === 'album'`), `musicbrainzReleaseId` → the pinning `mbReleaseId` hint.

### D2 — Standard Webhooks verification over the raw body; config-dormant registration

Verification mirrors the sender's scheme exactly (and the sibling's own inbound receiver conventions): decode the key from `whsec_<base64>`, enforce a ±300s window on `webhook-timestamp`, recompute HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` and compare timing-safely against any `v1,` entry of `webhook-signature`. The webhook route lives in its own Fastify scope whose content-type parser keeps the body a raw string, so verification strictly precedes JSON parsing; 401 on missing/invalid signature or stale timestamp. Configuration: `INTAKE_WEBHOOK_SECRET` absent → the route is not registered at all (config-dormant; startup logs state active vs dormant); present but malformed (not decodable `whsec_`/base64, or missing its companion `INTAKE_SOURCE_ROOT`) → fatal startup config error.

### D3 — Idempotency is durable, keyed by acquisition id, recorded on the event stream

Redelivery must converge without duplicate imports even after a restart — an in-memory delivery-id set is not enough, and the directory key alone fails the day the import applied and beets moved the files (the directory is gone; re-submission would 503 forever). So the linkage is an event-sourced fact: `SubmitImport`/`ImportRequested` gain an additive optional `source: { acquisitionId }`, and the status projection maintains an acquisition-id → import-id index rebuilt from the log at startup. The receiver checks the index first: a known acquisition acknowledges 204 as a converged no-op before any filesystem check. An unknown acquisition whose directory collides with a live import converges through `decide`'s existing directory-keyed idempotency (no event appended, no source recorded — and its own redelivery still converges the same way). Unknown event `type`s are acknowledged 2xx and ignored: the sender may add types, and 4xx-ing them would poison its retry queue.

### D4 — Path re-rooting with an explicit source root; a missing directory is retryable, never silently acked

`data.location` is meaningful only in the sender's namespace. New env `INTAKE_SOURCE_ROOT` names the sender's root prefix: the receiver requires `location` to fall strictly under it (rejecting escapes — prefix mismatch, `.`/`..`/empty segments — with a 4xx), strips it, and joins the remainder onto `INTAKE_ROOT`. Before submitting, the receiver verifies the re-rooted directory exists: if it does not (NFS visibility lag, an unmounted volume, a genuinely wrong root), it answers 503 so the sender's at-least-once retry redelivers later — a silent 2xx here would drop the release on the floor. The existence probe is injected by the composition root, keeping the interface layer free of direct filesystem coupling.

### D5 — Reuse the native submission path end to end

The translated delivery calls the same `submitImport` use-case the HTTP `POST /api/v1/imports` route uses — same directory normalization, same directory-derived import id, same policy stamping, same reactor-driven propose. The MusicBrainz release id rides as the standard `mbReleaseId` hint, which already pins the bridge's candidate search while distance still governs the verdict (bootstrap D4). No intake-specific command, no second pipeline; the event-driven door and the manual door converge on one code path, so every future improvement to submission serves both.

### D6 — Response taxonomy follows the sender's retry semantics

- `204` — acknowledged: submitted, or converged (known acquisition, live same-directory import, unknown event type).
- `401` — missing/invalid signature or stale timestamp (before any parsing).
- `400` — signature valid but the payload is unreadable (malformed JSON, schema violation) or its location escapes the source root: retrying without operator action cannot succeed, but a non-2xx keeps the delivery visible in the sender's retry/log surface rather than vanishing.
- `503` — the re-rooted directory does not exist yet; `500`/`409` — store faults and append races, exactly as the manual submit route maps them. All non-2xx cause sender redelivery; the split is diagnostic.

Error bodies follow the existing `{ error }` idiom. The route is hidden from the OpenAPI document (like the debug surface, it is machine-to-machine with a shared secret, documented here and in the spec deltas; the versioned `/api/v1` document remains the human/agent contract).

## Risks / Trade-offs

- **[Sender schema drift]** The downloader could reshape `acquisition.fulfilled`. → The frozen-fixture contract test fails on any reshaping that touches the read fields; tolerance covers everything else. The fixture is updated only deliberately, from a sender-recorded artifact.
- **[Same-directory, different acquisition]** A re-download of a release the importer is still processing converges onto the live import without recording the second acquisition id; its redeliveries keep converging through the directory key. Accepted: no duplicate import is possible, at the cost of the second acquisition never being independently traceable.
- **[Index growth]** The acquisition index grows with the log. Accepted at this scale (one entry per fulfilled download); it lives in the same in-memory projection as the status views and rebuilds identically.
- **[400 on misconfigured source root]** An operator with a wrong `INTAKE_SOURCE_ROOT` sees 400s, not 5xxs. The sender retries non-2xx uniformly, so a corrected config still gets the redelivery; the 400 makes the misconfiguration visible instead of looking like an outage.

## Open Questions

- Whether a periodic catch-up sweep (list intake, submit unknown directories) should back-stop lost deliveries — deferred until the sender's retry exhaustion is observed in practice.
