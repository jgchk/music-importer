## Why

Beets and its plugins print to stdout — the same stream the bridge uses for its JSON contract. In production this corrupted the channel twice on day one: a one-time `lastgenre` database migration flooded `validate` during boot (startup aborted; recovered only because the migration had completed by the restart), and a routine genre-change diff printed during `apply` landed *before* the JSON line, so a **successful** import (`status: applied`, files moved into the library) was recorded as a failed effect — the worst kind of divergence between record and reality. Any plugin, any beets version, any config can print at any time; the contract channel must be structurally immune, not clean by luck.

## What Changes

- The bridge isolates its JSON channel at the file-descriptor level: on entry it duplicates real stdout for its own exclusive use and repoints fd 1 (and `sys.stdout`) at stderr, so everything beets, its plugins, and any subprocess they spawn print flows to stderr — before config load, so even import-time chatter is caught. `emit` writes the contract JSON to the duplicated descriptor only.
- Bridge stderr remains what it already was: diagnostic context attached to failures by the TS adapter.
- The e2e beets config gains a deliberately noisy test plugin (via beets' `pluginpath`) that prints on plugin load and on import — deterministic, offline proof that plugin chatter cannot corrupt any verb's output.

## Capabilities

### Modified Capabilities

- `beets-bridge`: the schema-validated JSON boundary is guaranteed exclusive use of the bridge's output channel; plugin/library prints cannot corrupt it.

## Impact

- `src/adapters/beets/bridge/bridge.py` — fd duplication + redirection in `main()`/`emit` (small, mechanical).
- `test/e2e/run.sh` — writes the noisy fixture plugin and adds it to the config's `pluginpath`/`plugins`.
- No TS, port, schema, or fixture changes (recorded fixtures are the *parsed* channel's content, which is unchanged).
