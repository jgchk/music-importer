#!/usr/bin/env bash
# Out-of-process E2E tier: build (or reuse) the real image, run it against a hermetic beets
# fixture config + a tiny generated intake on a shared temp volume, drive the HTTP/MCP surface
# over a real socket, tear down. The matcher talks to the real MusicBrainz (the fixture albums pin
# small, stable Beatles singles), so the tier exercises a REAL beets end to end: propose →
# auto-apply/review → move-into-library.
#
# Env:
#   E2E_SKIP_BUILD=1   use the already-built `music-importer:e2e` image (CI gates the exact image
#                      it will publish, so it builds once and sets this).
#   E2E_PORT           host port to bind (default 3900).
set -euo pipefail

cd "$(dirname "$0")/../.."

IMAGE=music-importer:e2e
NAME=music-importer-e2e
NAME_DORMANT=music-importer-e2e-dormant
PORT="${E2E_PORT:-3900}"
DORMANT_PORT="${E2E_DORMANT_PORT:-3902}"
VERDICT_PORT="${E2E_VERDICT_PORT:-3901}"
export E2E_DATA_DIR="$(pwd)/.e2e-tmp"
export E2E_BASE_URL="http://localhost:$PORT"
export E2E_DORMANT_BASE_URL="http://localhost:$DORMANT_PORT"
export E2E_VERDICT_PORT="$VERDICT_PORT"

if [[ "${E2E_SKIP_BUILD:-0}" != "1" ]]; then
  docker build -t "$IMAGE" .
fi

dump_logs() {
  echo "=== docker logs (tail) ===" >&2
  docker logs --tail 150 "$NAME" >&2 || true
  echo "=== docker logs, dormant instance (tail) ===" >&2
  docker logs --tail 50 "$NAME_DORMANT" >&2 || true
}
cleanup() { docker rm -f "$NAME" "$NAME_DORMANT" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# Fresh shared data dir, owned by the invoking user; the container runs as this uid/gid so both
# sides share ownership of the SQLite file, the intake, and the library.
rm -rf .e2e-tmp
mkdir -p .e2e-tmp/music/intake .e2e-tmp/music/library .e2e-tmp/beets .e2e-tmp/data .e2e-tmp/data2

# Hermetic beets config: library-defining settings only; the bridge forces the session overlay.
# Intake and library share the /music parent so beets' move is a rename, never a cross-device copy.
cat > .e2e-tmp/beets/config.yaml <<'YAML'
directory: /music/library
library: /config/beets/library.db
import:
  move: yes
# Pre-plugin-era shape: no `musicbrainz` entry — the bridge must inject the source itself.
# scrub keeps the list non-empty and offline; noisy (below) prints to stdout at load and
# import time, proving plugin chatter cannot corrupt the bridge's JSON channel.
plugins: [scrub, noisy]
pluginpath: [/config/beets/plugins]
YAML

# A deliberately chatty plugin: real plugins (lastgenre diffs, db migrations) print to stdout
# whenever they feel like it; this makes that reproducible and offline for every verb.
mkdir -p .e2e-tmp/beets/plugins
cat > .e2e-tmp/beets/plugins/noisy.py <<'PY'
from beets.plugins import BeetsPlugin

print("NOISY plugin-load stdout chatter")


class NoisyPlugin(BeetsPlugin):
    def __init__(self):
        super().__init__()
        self.register_listener("library_opened", self._opened)
        self.register_listener("import_task_files", self._files)

    def _opened(self, lib):
        print("NOISY library_opened stdout chatter")

    def _files(self, task, session):
        print("NOISY import-files stdout chatter")
PY

# Generate the fixture intake with the image's own ffmpeg (no host ffmpeg needed). Each album
# pins a real, stable MusicBrainz release whose durations the silent files reproduce (or mangle).
gen() { # gen <subdir/file> <seconds> <artist> <album> <title> <track>
  docker run --rm --user "$(id -u):$(id -g)" --entrypoint ffmpeg \
    -v "$E2E_DATA_DIR/music/intake:/intake" "$IMAGE" \
    -v error -f lavfi -i "anullsrc=r=22050:cl=mono" -t "$2" -b:a 32k \
    -metadata artist="$3" -metadata albumartist="$3" -metadata album="$4" \
    -metadata title="$5" -metadata track="$6/2" -y "/intake/$1"
}
mkdir -p .e2e-tmp/music/intake/{love-me-do,please-please-me,mystery,webhook-drop,dormant-drop}
# Strong: The Beatles — Love Me Do (1988 single, 22c9f6a3-…): exact durations → auto-apply.
gen "love-me-do/01 Love Me Do.mp3"      143 "The Beatles" "Love Me Do" "Love Me Do"      1
gen "love-me-do/02 P.S. I Love You.mp3" 123 "The Beatles" "Love Me Do" "P.S. I Love You" 2
# Weak: Please Please Me (1988 single, 710bdd49-…) with a 30s stub → review with penalty detail.
gen "please-please-me/01 Please Please Me.mp3" 30  "The Beatles" "Please Please Me" "Please Please Me" 1
gen "please-please-me/02 Ask Me Why.mp3"       145 "The Beatles" "Please Please Me" "Ask Me Why"       2
# Reject fodder: an album MusicBrainz cannot confidently match.
gen "mystery/01 Jam One.mp3" 61 "Unknown Homie xq77" "Basement Tape zz93" "Jam One" 1
gen "mystery/02 Jam Two.mp3" 59 "Unknown Homie xq77" "Basement Tape zz93" "Jam Two" 2
# Webhook fodder: deposited "by the downloader", submitted via the signed acquisition receiver.
gen "webhook-drop/01 Wire One.mp3" 62 "Unknown Homie xq77" "Webhook Tape zz94" "Wire One" 1
gen "webhook-drop/02 Wire Two.mp3" 58 "Unknown Homie xq77" "Webhook Tape zz94" "Wire Two" 2
# Dormant fodder: same shape, driven against the dormant-publisher instance below.
gen "dormant-drop/01 Quiet One.mp3" 63 "Unknown Homie xq77" "Dormant Tape zz95" "Quiet One" 1
gen "dormant-drop/02 Quiet Two.mp3" 57 "Unknown Homie xq77" "Dormant Tape zz95" "Quiet Two" 2

# The dormant instance gets its own beets config + library.db (no SQLite cross-container sharing).
cp -r .e2e-tmp/beets .e2e-tmp/beets2

# The intake receiver's shared secret + the sender-namespace root (mirrored by webhook.e2e.test.ts),
# and the outbound verdict publisher's secret + host-side stub subscriber URL (the vitest process
# runs the stub; host.docker.internal resolves to the host gateway via --add-host below).
INTAKE_SECRET="whsec_$(printf %s 'e2e-intake-signing-key' | base64)"
VERDICT_SECRET="whsec_$(printf %s 'e2e-verdict-signing-key' | base64)"

docker run -d --name "$NAME" -p "$PORT:3000" \
  --user "$(id -u):$(id -g)" \
  --add-host=host.docker.internal:host-gateway \
  -e INTAKE_ROOT=/music/intake \
  -e INTAKE_WEBHOOK_SECRET="$INTAKE_SECRET" \
  -e INTAKE_SOURCE_ROOT=/downloads/import \
  -e VERDICT_WEBHOOK_URLS="http://host.docker.internal:$VERDICT_PORT/verdicts" \
  -e VERDICT_WEBHOOK_SECRET="$VERDICT_SECRET" \
  -e BEETS_CONFIG=/config/beets/config.yaml \
  -e DATABASE_FILE=/data/events.db \
  -e HOME=/tmp \
  -v "$E2E_DATA_DIR/music:/music" \
  -v "$E2E_DATA_DIR/beets:/config/beets" \
  -v "$E2E_DATA_DIR/data:/data" \
  "$IMAGE" >/dev/null

# A second instance with NO VERDICT_* config: proves dormant means dormant end to end (its verdicts
# are recorded but never delivered anywhere). Shares the intake mount; owns its beets + event DBs.
docker run -d --name "$NAME_DORMANT" -p "$DORMANT_PORT:3000" \
  --user "$(id -u):$(id -g)" \
  -e INTAKE_ROOT=/music/intake \
  -e INTAKE_WEBHOOK_SECRET="$INTAKE_SECRET" \
  -e INTAKE_SOURCE_ROOT=/downloads/import \
  -e BEETS_CONFIG=/config/beets/config.yaml \
  -e DATABASE_FILE=/data/events.db \
  -e HOME=/tmp \
  -v "$E2E_DATA_DIR/music:/music" \
  -v "$E2E_DATA_DIR/beets2:/config/beets" \
  -v "$E2E_DATA_DIR/data2:/data" \
  "$IMAGE" >/dev/null

# Wait until both APIs actually answer (bounded per-attempt; startup includes bridge validation).
deadline=$(( $(date +%s) + 180 ))
for url in "$E2E_BASE_URL" "$E2E_DORMANT_BASE_URL"; do
  until curl -fsS --max-time 3 "$url/api/v1/imports" >/dev/null 2>&1; do
    if (( $(date +%s) >= deadline )); then
      echo "readiness timeout: $url did not answer in time" >&2
      dump_logs
      exit 1
    fi
    sleep 2
  done
done
echo "ready: app + dormant instance"

if ! pnpm exec vitest run --config test/e2e/vitest.config.ts; then
  dump_logs
  exit 1
fi
