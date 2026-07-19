## 1. Event-sourcing machinery (copied from music-downloader, adapted)

- [x] 1.1 Copy + adapt the SQLite event store, upcaster registry, in-process bus, and checkpoint store (`src/adapters/sqlite/`, `src/application/ports/event-store-port.ts`) with their tests; strip acquisition-specific naming.
- [x] 1.2 Copy + adapt the command handler and checkpointed reactor loop (`src/application/`) with tests; the interpreter is stubbed until 4.x supplies real effects.

## 2. The Import aggregate (pure domain)

- [x] 2.1 Write failing tests for the domain events and state fold: `ImportRequested` (directory, hints), `CandidatesProposed` (typed candidates), `AutoApplySelected`, `ReviewRequired` (kind + carried context), `ReviewResolved` (verb + payload), `ImportApplied`, `RemediationRequired`, `ImportRejected` (reason, files-deleted marker); phases `requested → proposing → awaiting-review | applying → applied | rejected`; total, tolerant `evolve`.
- [x] 2.2 Implement events/state; then failing tests + implementation for `decide`: idempotent submission, auto-apply at threshold (hint pins search, distance governs), review routing per kind (match/no-match/duplicate/remediation), resolution verbs incl. manual tags + as-is + reject, no-op on settled reviews, doomed-effect rejection.
- [x] 2.3 Failing tests + implementation for `react`: `Propose` effect on requested/refresh/supply-id, `Apply` effect on auto-apply and apply-verbs, `DeleteIntake` effect on reject; expose the `Import` facade; lint-encapsulate decider internals (eslint zone like the downloader's aggregate).

## 3. Ports + beets bridge

- [x] 3.1 Define `TaggerPort` (propose/apply) and `IntakePort` (delete a release dir) in `src/application/ports/` with zod schemas for the bridge JSON (candidates keyed by `(data_source, album_id)`, distances, penalties, track mapping); failing contract-shape tests first.
- [x] 3.2 Write the Python bridge (`src/adapters/beets/bridge/`): config load → forced session overlay (`config.set()` before `load_plugins()`) → `propose` via `tag_album` (optional `--search-id`) emitting the contract JSON; `apply` via an `ImportSession` subclass resolving the chosen candidate through `search_ids` (plus `--as-is` and `--tags` modes). Pin the beets version.
- [x] 3.3 Write the TS bridge adapter (`src/adapters/beets/`): spawn, timeout, zod-validate, translate to port types, map failures to `InfraError`; unit tests against recorded bridge output (frozen fixtures = the bridge contract tests).
- [x] 3.4 Record real bridge fixtures against a pinned beets + tiny fixture library (script under `test/contract/`, mirroring the downloader's record tooling); wire `test:contract` into `check` and the pipeline.
- [x] 3.5 Implement the filesystem `IntakePort` adapter (delete release dir, prune empties, tolerate already-gone) with tests.

## 4. Application services

- [x] 4.1 Interpreter effects: `Propose` → tagger.propose → `RecordProposal`; `Apply` → tagger.apply → `RecordApplied`/`RecordRemediationRequired`/failure; `DeleteIntake` → intake.delete → recorded on the rejection path; failing tests first; bridge invocations serialized through the reactor (one at a time).
- [x] 4.2 Projections/read models: import status view (with history), pending-reviews view (kind + context); failing tests first.
- [x] 4.3 Startup validation: beets config parse + directory/db existence via a bridge `validate` verb (or propose dry-run); fail boot loudly; expose effective config on a debug endpoint.

## 5. Public surface

- [x] 5.1 Zod contracts (`src/interfaces/contracts/`): submit request (path + hints), import status DTO, pending-review DTOs per kind, resolve-review request (verb union incl. full tag payload with track mapping); failing round-trip tests.
- [x] 5.2 HTTP routes on `/api/v1/imports` (submit 202, list, get, `reviews` list, resolve) + OpenAPI; failing inject tests first; additive over the scaffold's list endpoint.
- [x] 5.3 MCP server: same operations as tools/resources from the same schemas; failing tests via the MCP SDK client.

## 6. Composition, image, E2E

- [x] 6.1 Composition root wiring (config: intake root, beets config path, thresholds, db file); config schema tests.
- [x] 6.2 Dockerfile runtime stage: python3 + pinned beets + ffmpeg + chromaprint + oggz-tools + opus-tools; bridge sources copied in; image builds in CI.
- [x] 6.3 Out-of-process E2E (`test/e2e/`): real beets against a hermetic fixture config + tiny library on a temp volume — scenarios: confident auto-apply lands files in the library; weak match waits in review and resolves via apply-candidate; reject deletes intake files; version endpoint. Update `run.sh` orchestration.

## 7. Gate

- [x] 7.1 `pnpm check` fully green (format, lint incl. new eslint zones, typecheck, build, 100% coverage, contract, release) + `pnpm test:e2e` green.
- [x] 7.2 Doc pass: adapter/bridge doc comments match the shipped behavior; README status updated; CLAUDE.md stack note confirmed.
