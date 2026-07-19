# Contract tier: the beets bridge

Frozen, recorded JSON from the real Python bridge (`src/adapters/beets/bridge/bridge.py`) running
against the **pinned** beets (`src/adapters/beets/bridge/requirements.txt`), validated at test
time against the same zod schemas the runtime adapter enforces (`src/adapters/beets/schemas.ts`).
No Python, no network, and no containers are needed to _run_ this tier — it gates every commit via
`pnpm test:contract` (part of `pnpm check` and the CI pipeline).

## Re-recording (a deliberate upgrade event)

Whenever the beets pin changes:

```sh
bash test/contract/record-bridge-fixtures.sh
```

Requirements: `python3` (the script maintains a hermetic venv at `test/contract/.venv`,
gitignored), `ffmpeg` (generates the tiny fixture library), and network access to
musicbrainz.org. The matcher fixtures pin The Beatles' "Love Me Do" single (1988, MBID
`22c9f6a3-0569-4c59-b551-cb4a26b0bc3f`) — two short, duration-annotated tracks make silent
generated audio match at distance ~0.

Commit the refreshed `fixtures/beets-bridge/*.json` together with the pin bump; the tests refuse
fixtures whose provenance does not match the pinned version.
