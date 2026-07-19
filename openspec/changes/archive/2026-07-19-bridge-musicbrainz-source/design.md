## Context

Beets 2.x moved the built-in MusicBrainz autotagger source into a `musicbrainz` plugin. Beets only loads the plugins named in `plugins:` once that key is set, so a user config written for an older beets (where the source was implicit) loses MusicBrainz candidate sourcing entirely under the pinned 2.12 — no candidates, no MBID pinning, every import lands in no-match review. The bridge's design already splits responsibility: the user's config is authoritative for everything *library-defining*; the session overlay owns everything the *service session* requires (non-interactivity, no resume, single-threaded). Candidate sourcing from MusicBrainz falls on the session side of that line: the service's propose/apply contract is meaningless without it.

## Decisions

### D1 — Inject `musicbrainz` into the effective plugin list at bootstrap, never into the user's file

`bootstrap()` appends `musicbrainz` to `config["plugins"]` (via `config.set()`, same mechanism as the session overlay) when absent, after the user's config loads and before `load_plugins()` — the only point where the merged view can be corrected and plugins still see it. Alternatives rejected:

- **Edit the user's config file** — their own CLI (an older beets without the plugin module) errors on every invocation; and the file is the user's, not the service's.
- **A service-owned copy of the config** — splits `BEETSDIR`, so plugin token sidecars and `state.pickle` stop resolving like manual CLI use, violating the library-parity requirement for a one-word gain.
- **Require the user to upgrade their beets** — couples the user's tooling to the service's pin; the pin exists precisely so the two can differ.

### D2 — Only the MusicBrainz source; other sources stay opt-in

`discogs`, `bandcamp`, `deezer`, `spotify` were plugins in every beets the user could have written a config for — an absent entry there is a real choice. `musicbrainz` is the only source whose absence is an artifact of version skew rather than intent. The injection is therefore a single hard-coded name, not a configurable list.

## Risks / Trade-offs

- **[User genuinely wants no MusicBrainz source]** Theoretical; the service's matching contract assumes MB ids throughout (pinning hints, candidate identity). If that need ever materializes it becomes an explicit config knob — additive.
- **[Effective plugins diverge from `beet config` output]** By one visible entry, reported honestly by `validate`/the debug endpoint — same observability posture as the session overlay itself.
