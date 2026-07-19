## Why

Real user configs predate beets' plugin-ification of the MusicBrainz source. Beets moved its built-in MusicBrainz autotagger source into a `musicbrainz` plugin; under the pinned beets 2.12, a config that sets `plugins:` without listing it loads **zero MusicBrainz candidates** — verified against the pinned venv (`plugins: fetchart embedart` → `musicbrainz` not loaded). The production config this service exists to serve is exactly that shape (written for beets 2.3.1, where the source was built-in), so every import would silently degrade to a no-match review and MBID pinning hints would resolve nothing. Editing the user's config is not an option: their own older CLI errors on the unknown `musicbrainz` plugin name, and the config is theirs, not ours.

## What Changes

- The bridge's session bootstrap guarantees the MusicBrainz candidate source: after the user's config loads and the session overlay applies, `musicbrainz` is appended to the effective plugin list if (and only if) it is absent, before `load_plugins()`. Configs that already list it are untouched byte-for-byte in effect.
- The `validate` verb (and therefore the effective-config debug endpoint) reports the effective plugin list including the injection, so the guarantee is inspectable.
- The out-of-process e2e's user config drops `musicbrainz` from its plugin list — mirroring the production config's shape — so the auto-apply scenario proves the injection end to end. Contract fixtures and their recording config are untouched (their configs already list `musicbrainz`; the injection no-ops there, so the frozen fixtures remain valid).

Explicitly not in scope: injecting any other metadata-source plugin (`discogs`, `bandcamp`, `deezer`, `spotify` were always opt-in plugins — honoring the user's list is correct for them) and modifying the user's configuration file in any way.

## Capabilities

### Modified Capabilities

- `beets-bridge`: the session overlay's guarantee extends beyond non-interactivity — the bridge also ensures the MusicBrainz candidate source is loaded regardless of a plugin list written for older beets, without touching the user's config.

## Impact

- `src/adapters/beets/bridge/bridge.py` — `bootstrap()` gains the plugin-list injection (a few lines plus doc comment).
- `test/e2e/run.sh` — the generated user config's `plugins:` line loses `musicbrainz` (gains a benign offline plugin to stay a realistic non-empty list).
- No TypeScript, schema, port, or fixture changes; no public-API change.
