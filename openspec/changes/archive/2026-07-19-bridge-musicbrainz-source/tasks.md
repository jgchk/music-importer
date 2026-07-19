## 1. Red, then green, then gate

- [x] 1.1 Red: change the e2e user config (`test/e2e/run.sh`) to a pre-plugin-era shape — `plugins:` without `musicbrainz` (keeping a benign offline plugin so the list is non-empty) — and observe the auto-apply scenario fail against the unmodified bridge (no MusicBrainz candidates). Component-level red already demonstrated against the pinned venv.
- [x] 1.2 Green: `bootstrap()` appends `musicbrainz` to `config["plugins"]` when absent (after the user config + session overlay, before `load_plugins()`), with a doc comment stating the version-skew rationale; `validate` continues to report the effective list (now including the injection). Verify at the venv level, then `pnpm test:e2e` fully green.
- [x] 1.3 Gate: `pnpm check` green (contract fixtures untouched and still passing — their configs already list `musicbrainz`, so injection no-ops); bridge doc header reflects the guarantee.
