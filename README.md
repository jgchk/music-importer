# music-importer

An extensible, event-sourced music importer. Given music files — deposited by [music-downloader](https://github.com/jgchk/music-downloader) or pointed at manually — it proposes [beets](https://beets.io)-powered metadata matches, auto-imports confident ones into the library, and queues uncertain ones for human review, exposed over HTTP and MCP.

Beets remains the library's system of record; this tool narrates and drives the _import process_.

## Status

Core shipped (OpenSpec change `bootstrap-import-core`): the event-sourced `Import` aggregate, the
stateless Python beets bridge (pinned beets 2.12), the typed review queue with its resolution
verbs, auto-apply policy, and the HTTP + MCP surface on `/api/v1/imports`. Follow-ups on deck:
music-downloader webhook intake, the quality-ladder duplicate policy, outbound verdict events, and
notifications.

## Running

The Docker image bakes Node, the pinned beets in a venv, and the plugin-chain binaries (ffmpeg,
fpcalc, oggz-tools, opus-tools). Configuration is environment-only — see `.env.example` for every
variable. Required: `INTAKE_ROOT` and `BEETS_CONFIG`; mount intake and the beets library under one
parent so imports are renames, keep beets' `library.db` on local disk (not NFS), and give
`DATABASE_FILE` a persistent volume.

## Development

- `pnpm check` — the full gate (format, lint, typecheck, build, tests w/ 100% coverage, bridge
  contract fixtures, release tooling).
- `pnpm test:contract` — frozen beets-bridge fixtures against the runtime schemas (no network).
- `pnpm test:e2e` — out-of-process E2E against the built Docker image (real beets + MusicBrainz).

See `CLAUDE.md` and `docs/development/` for the development constitution.
