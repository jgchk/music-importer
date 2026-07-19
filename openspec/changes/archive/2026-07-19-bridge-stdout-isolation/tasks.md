## 1. Red, then green, then gate

- [x] 1.1 Red: add a deterministic noisy fixture plugin to the e2e beets config (`pluginpath` + `plugins` entry) that prints to stdout on plugin load and at import stages; observe e2e fail against the unmodified bridge (validate/propose/apply output polluted). Component-level red demonstrable against the pinned venv.
- [x] 1.2 Green: `main()` duplicates real stdout into a private contract descriptor and repoints fd 1 + `sys.stdout` at stderr before any beets work; `emit()` writes to the private descriptor; venv-level check, then `pnpm test:e2e` fully green.
- [x] 1.3 Gate: `pnpm check` green (recorded fixtures unchanged — the parsed channel's content is identical); bridge doc header notes the channel guarantee.
