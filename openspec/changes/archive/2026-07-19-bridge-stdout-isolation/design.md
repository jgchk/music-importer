## Context

The bridge promises one JSON document on stdout per invocation; beets was designed as a CLI and prints freely (plugin loads, migrations, change diffs) through `print()`/`ui.print_` — all to fd 1. Two production incidents on deploy day proved interleaving is routine, not exotic. The TS adapter correctly refused to parse polluted output (contract drift surfacing as an infra error, per spec) — the defect is on the Python side of the boundary.

## Decisions

### D1 — Isolate at the file-descriptor level, on entry, once

`main()` `os.dup()`s fd 1 into a private descriptor for the contract channel, then `os.dup2()`s stderr over fd 1 and rebinds `sys.stdout`, before any beets import or config load. Everything downstream — beets, plugins, C extensions, subprocesses like ffmpeg — inherits fd 1 = stderr and cannot touch the contract channel. `emit()` writes to the private descriptor. Alternatives rejected:

- **Rebind only `sys.stdout`** — misses C-level and subprocess writes (replaygain's ffmpeg, chroma's fpcalc), which write to fd 1 directly.
- **Tolerant parsing on the TS side (last-line JSON)** — keeps a corrupted channel and gambles that noise never interleaves mid-JSON; weakens the contract instead of enforcing it.
- **Suppress plugin verbosity via config** — beets has no universal quiet switch for plugin prints; migrations in particular ignore verbosity settings.

### D2 — Deterministic noise in the e2e, not a chatty real plugin

A five-line fixture plugin (loaded via beets' `pluginpath`) prints to stdout at plugin load and at import time. Real chatty behavior (`lastgenre` diffs, migrations) is environment- and state-dependent; the fixture makes the red/green cycle reproducible offline and permanently guards every verb.

## Risks / Trade-offs

- **[Diagnostics move to stderr]** Intentional: stderr is already the diagnostic channel the adapter attaches to failures. Operators lose nothing; the JSON gains exclusivity.
