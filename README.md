# music-importer

An extensible, event-sourced music importer. Given music files — deposited by [music-downloader](https://github.com/jgchk/music-downloader) or pointed at manually — it proposes [beets](https://beets.io)-powered metadata matches, auto-imports confident ones into the library, and queues uncertain ones for human review, exposed over HTTP and MCP.

Beets remains the library's system of record; this tool narrates and drives the _import process_.

## Status

Core shipped (OpenSpec change `bootstrap-import-core`): the event-sourced `Import` aggregate, the
stateless Python beets bridge (pinned beets 2.12), the typed review queue with its resolution
verbs, auto-apply policy, and the HTTP + MCP surface on `/api/v1/imports`. Shipped since
(`downloader-intake`): the signed acquisition webhook receiver — music-downloader's
`acquisition.fulfilled` events submit imports automatically (`POST /api/v1/webhooks/acquisitions`,
Standard Webhooks signatures, durable idempotency by acquisition id; configure
`INTAKE_WEBHOOK_SECRET` + `INTAKE_SOURCE_ROOT`, and point the downloader's `WEBHOOK_URLS` at the
receiver). Shipped since (`outbound-release-verdicts`): the outbound `release.verdict` publisher —
resolving a downloader-delivered review with `reject-and-retry-download` deletes the files AND
ships a signed verdict back to the downloader, which revives the acquisition for a better copy
(configure `VERDICT_WEBHOOK_URLS` + `VERDICT_WEBHOOK_SECRET`, the same secret value the
downloader's verdict receiver verifies with; producer-owned contract under `contracts/events/`).
Follow-ups on deck: the quality-ladder duplicate policy and notifications.

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
