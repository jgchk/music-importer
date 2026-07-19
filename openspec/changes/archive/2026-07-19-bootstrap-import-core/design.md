## Context

Today the library is managed by hand: music-downloader deposits validated releases into a shared intake directory (`/mnt/monad/jake/music-downloader/import` in production), and imports happen via interactive `beet import` sessions over SSH. Beets' configuration (`~/.config/beets/config.yaml`) carries a heavy plugin chain (fetchart, embedart, badfiles, replaygain, chroma, lastgenre, scrub, …); its SQLite `library.db` lives on the host's **local disk** (not NFS — important, see D6); the music library sits on an NFS mount. `import: move: yes` means successful imports drain the intake dir.

The design below was settled in an extended exploration (2026-07-18/19), including research passes against beets 2.12 internals, reference implementations (beets-flask: healthy, genuinely two-phase; betanin: PTY-scraping anti-pattern, maintenance-only), and the EDA contract-ownership literature. Key upstream facts verified: beets' `tag_album(…, search_ids)` performs a **direct ID lookup, not a fuzzy re-search**, making two-phase propose/apply deterministic; confuse config overlays via `config.set()` take precedence over file sources when applied before `load_plugins()`; beets uses a 5s SQLite busy timeout with no retry.

## Goals / Non-Goals

**Goals:**

- Automate the confident majority of imports end-to-end; push every uncertain decision to the user as a first-class, resolvable resource over HTTP and MCP — never require SSH or the interactive beets CLI.
- Wrap beets, don't reimplement it: matching, tagging, moving, and the plugin chain are beets'; this service owns orchestration, state, and the review UX.
- Manual import ("import this folder") is fully functional standalone — no music-downloader required, ever.
- Keep the pure domain I/O-free; keep 100% coverage; keep the public API additive-only — the full sibling constitution.

**Non-Goals:**

- No library mutations outside beets (no direct file tagging or moving in this codebase; the only filesystem writes this service performs itself are intake-dir deletions on reject).
- No music-downloader coupling in this change: no webhook intake, no verdict events, no knowledge of acquisitions. The API is designed so those adapters land additively later.
- No duplicate *policy* yet (quality-ladder auto-replace is a follow-up); duplicates surface as review items with manual verbs.
- No notifications yet (`NotificationPort` is a follow-up); the review queue is pull-only in this change.

## Decisions

### D1 — An event-sourced `Import` aggregate that owns the process, never the library

One aggregate, `Import`, per submitted directory: `requested → proposing → awaiting-review | applying → applied | rejected`, built on the decide/evolve/react decider exactly as the constitution prescribes. Human decisions are events (`ReviewResolved` carries what you chose and why it was offered), so the stream answers "why does this album have these tags?" forever. The boundary that keeps this honest: **beets' `library.db` is the system of record for the library**; the stream narrates only the import *process*. Manual `beet` CLI use continues to mutate the library outside this stream, and that is fine — the aggregate treats beets' state as observed reality, never as something it owns. Machinery (SQLite event store, checkpointed reactor, in-process bus, projections) is **copied from music-downloader, not extracted into a shared package** — duplication is cheaper than a premature abstraction; extraction waits until both services are stable.

### D2 — Beets behind a port: a stateless Python bridge CLI, two-phase propose/apply

Beets is Python; this service is TypeScript. The seam is the same one music-downloader uses for ffmpeg: an external tool spawned behind an outbound port (`TaggerPort`), speaking a zod-validated JSON contract. The bridge is a small **stateless** CLI with two verbs:

- `propose <dir> [--search-id <id>]` — load config, run beets' matcher (`tag_album`), emit candidates as JSON: identity as the **`(data_source, album_id)` pair** (beets 2.x treats metadata sources as pluggable — a bare MBID is ambiguous), overall distance, per-penalty breakdown (missing/extra tracks, duration deltas…), and the track mapping.
- `apply <dir> --candidate <source>:<album_id>` (or `--as-is`, or `--tags <json>`) — re-resolve the chosen candidate via `search_ids` (a deterministic by-ID lookup), run the import session so the full beets pipeline fires: tagging, move-into-library, plugin chain.

Statelessness is a feature, not a compromise: each invocation reads current beets/library state (no stale in-process caches — a verified beets footgun for long-running embedded `Library` objects), crashes cannot strand a session, and the two phases can be days apart (review latency) because apply re-derives rather than deserializing pickled state. beets-flask proves the session-subclass pattern in production; we take the simpler re-lookup variant. The bridge and beets are **version-pinned in the image**; beets' importer/autotag internals were reorganized within the 2.x line, so upgrades are deliberate contract-verification events, mechanized by contract tests over recorded bridge output.

### D3 — The user's beets config is the base; the bridge force-overlays session keys

Beets config is two things in one file: **library-defining** config (directory, db, path formats, plugin chain) and **session** config (interactivity, resume, incremental). The library-defining half must be identical no matter which door music enters through — Jake keeps using the beets CLI, so a diverging importer config would silently fork the library's behavior. Therefore: the bridge loads the user's own config (path injectable, hermetic fixtures in tests) and **unconditionally overrides a small documented set of session keys** — non-interactive always, no resume, no incremental, quiet handling — applied via `config.set()` *before* `load_plugins()` (the verified ordering requirement). Startup validation fails loudly on unusable config (missing db/directory, unparseable YAML) rather than failing at first import; the effective merged config is exposed on a debug endpoint.

### D4 — Auto-apply policy: distance governs; a hint helps but never overrides

A strong match auto-applies — for both automated and manual submissions. A submission may carry hints (a MusicBrainz release ID, artist/album strings): hints *pin the search* (near-deterministic candidates), but the **distance still governs the verdict**. A hinted candidate with a bad distance (missing tracks, wrong durations) routes to review carrying exactly which penalties fired — the "the downloader thinks this is RAM but track 7 is a 30-second stub" case goes to a human with the evidence, offering apply-anyway and reject among the verbs. Thresholds come from config, defaulting to beets' own strong-match threshold.

### D5 — The review queue: a union of kinds, resolved through the same API that submits

`awaiting-review` items are typed: **match-review** (weak or hint-contradicted match; carries candidates + distances + mismatch detail), **no-match** (empty candidate list — distinct in the UX: "beets found nothing" vs "low confidence"), **duplicate-review** (beets detected the album in the library; verbs: replace / keep-both / reject — policy automation is a follow-up), **remediation-review** (see D7). Resolution verbs (HTTP + MCP, one zod contract source): `apply-candidate`, `supply-id` (pinned re-propose), `refresh-candidates` (fresh re-propose — candidates can go stale over weeks), `manual-tags` (full per-track tag payload with explicit track mapping; beets applies the user's fields with autotag bypassed, plugins still fire), `import-as-is`, `reject`. **Reject deletes the release's files from intake** — the queue owns intake hygiene; nothing lingers by design. All submission and resolution commands are idempotent (an import is keyed by its directory; a redelivered resolution of a settled review no-ops through `decide`).

### D6 — Deployment posture: local db, one mount, serialized imports

Three verified constraints shape deployment: (1) beets' `library.db` must stay on **local disk** (SQLite over NFS is explicitly unsafe; the db already lives on local ext4 — the container bind-mounts the whole beets config dir: config + db + plugin token files). (2) Intake and library both live under one NFS parent — the container mounts that parent **as a single bind mount** so beets' move is a server-side rename, not an EXDEV copy+delete across bind mounts. (3) Imports are **serialized** — one bridge invocation at a time through the reactor queue — because beets' SQLite has a 5s busy timeout and no retry; occasional concurrent manual CLI use stays safe precisely because service-side transactions are short and single-file. The image bakes the plugin chain's binaries (ffmpeg for replaygain, chromaprint/`fpcalc` for chroma, oggz-tools + opus-tools for badfiles) so the user's plugin config works unmodified.

### D7 — A partial apply failure is `applied`-with-remediation, never `failed`

Apply runs beets' plugin chain, parts of which are network- or CPU-dependent (fetchart, lastgenre, replaygain). If files moved but enrichment failed, the album **is** in the library — modeling that as `failed` would lie. The import lands `applied` with a **remediation-review** item recording exactly what failed, offering `accept` (log and close) and `retry-enrichment`. A failure *before* files move (bridge crash, beets error) is a plain retryable effect failure through the reactor, and a doomed import lands `rejected` with its reason.

## Risks / Trade-offs

- **[Beets internal APIs]** `autotag`/`importer` are not a public contract and were reorganized within 2.x. → Pin the version in the image; contract tests over recorded bridge JSON; upgrades are deliberate, verified events.
- **[Bridge JSON fidelity]** Serializing candidates (distances, penalties, track mappings) loses beets' rich objects. → Serialize only what the review UX and apply-by-ID need; `apply` re-derives everything else inside beets.
- **[Two-phase drift]** MusicBrainz data can change between propose and a weeks-later apply. → Apply re-fetches by stable ID (current data, not a snapshot); `refresh-candidates` exists for the list itself; a candidate deleted upstream surfaces as an apply failure routed back to review.
- **[Python in a TS shop]** One more runtime in the image and a second language surface. → The bridge is deliberately tiny (two verbs, no server, no state); its size is a design invariant, not an accident.
- **[Concurrent manual CLI use]** A long manual beets session could collide with a service import. → Serialized service imports + short transactions make collisions rare; a busy-timeout error is a retryable effect failure, not corruption.

## Open Questions

- Exact default match thresholds (adopt beets' `strong_rec_thresh` as-is vs. a stricter service default) — decide during implementation against real proposals from the fixture library.
- Whether `refresh-candidates` should be automatic when a review item is *read* after some staleness window, or verb-only — verb-only in this change; revisit with real usage.
