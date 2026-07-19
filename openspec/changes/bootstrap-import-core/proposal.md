## Why

Downloaded music currently reaches the library by hand: releases land in a shared intake directory and Jake SSHes into the host to run `beet import` interactively. The gap between "downloaded" and "in the library" is the last manual step in an otherwise automated pipeline — and the interactive CLI is the only way to resolve uncertain matches, which means no automation can exist without losing the human-in-the-loop that keeps the library clean.

This founding change builds `music-importer`: a small, focused service that wraps beets (never reimplements it), auto-imports confident matches, and pushes uncertain ones back to the user as reviewable, resolvable items — over HTTP and MCP, so any frontend or agent can drive it. Manual import ("import this folder") is the primal case; automated intake from music-downloader arrives in a follow-up change as just another client of the same API.

## What Changes

- An event-sourced **`Import` aggregate** (decide/evolve/react, mirroring music-downloader's constitution): `requested → proposing → awaiting-review | applying → applied | rejected`, with the event stream narrating the *import process*. Beets' library database remains the system of record for the library itself.
- A stateless **Python beets bridge CLI** behind an outbound `TaggerPort`: `propose <dir>` runs beets' matcher and emits candidates as JSON (keyed by `(data_source, album_id)` pairs, with distance/penalty detail); `apply <dir> --candidate <ref>` performs the import via a deterministic by-ID lookup, firing the full beets pipeline (tagging, move, plugins). The bridge loads the user's own beets config and force-overlays a small documented set of session keys (always non-interactive); beets is version-pinned in the image and the JSON boundary is zod-validated and contract-tested.
- A **review queue** exposing pending imports as resolvable items, as a union of kinds: match-review (weak or hint-contradicted matches, carrying the exact mismatch), no-match, duplicate-review, and remediation-review (apply partially failed *after* files moved). Resolution verbs: apply candidate, supply a MusicBrainz ID (pinned re-propose), refresh candidates, full manual tag payload, import as-is, reject. Reject deletes the files and cleans intake.
- **Auto-apply policy**: a strong match auto-applies (a source-supplied MBID hint aids matching but distance governs — a hint with a bad distance routes to review with the mismatch explained); everything else waits for a human.
- The **HTTP + MCP surface** from one zod contract source: submit an import (`path` + optional hints), list/get imports, list pending reviews, resolve a review — all additive on the `/api/v1/imports` base path anchored by the scaffold.
- **Docker image** gains python3 + pinned beets + the plugin-chain binaries (ffmpeg, chromaprint, oggz-tools, opus-tools); the out-of-process E2E drives a real import through a real beets against a fixture library.

Explicitly deferred to follow-up changes: music-downloader webhook intake (source adapter + catch-up sweep), the *arr-style quality-ladder duplicate policy (core ships duplicate-review with manual verbs), outbound `release.verdict` events + the retry-download loop, and the NotificationPort. The API shapes here are designed so each of those lands additively.

## Capabilities

### New Capabilities

- `import-management`: the event-sourced import lifecycle — submission (idempotent), proposing via the bridge, auto-apply policy, terminal outcomes, and the process/library boundary.
- `match-review`: the review queue — kinds, carried context (candidates, distances, mismatch detail), resolution verbs, and reject semantics.
- `beets-bridge`: the bridge contract — propose/apply verbs, config overlay rules, non-interactive enforcement, serialized execution, and version pinning.
- `public-api`: the versioned HTTP + MCP surface for imports and reviews.

### Modified Capabilities

<!-- none — founding change -->

## Impact

- `src/domain/import/` — the aggregate: events, commands, state fold, decide, react, facade.
- `src/application/` — command handler, reactor + interpreter for bridge effects, review/import projections, ports (`TaggerPort`, `IntakePort` for file deletion).
- `src/adapters/beets/` — the bridge adapter (spawn, zod-validate, translate) + `bridge/` Python CLI sources; `src/adapters/sqlite/` — event store, checkpoints (copied from music-downloader, adapted).
- `src/interfaces/` — HTTP routes + MCP tools from shared zod contracts.
- `src/composition/` — wiring, config (beets config path, intake root, thresholds).
- `Dockerfile` — python3 + pinned beets + plugin binaries in the runtime stage.
- `test/e2e/` — real-beets import scenarios (auto-apply, review-resolve, reject).
