# syntax=docker/dockerfile:1

# --- Builder: install all deps (incl. native better-sqlite3 build) and compile TypeScript --------
FROM node:24.18.0-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# Toolchain for native modules (better-sqlite3) that lack a prebuild for this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# pnpm-workspace.yaml carries the pnpm 11 `allowBuilds` setting that permits better-sqlite3's native
# build; without it the install skips the native addon and the runtime image is broken.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# Drop dev dependencies, keeping the compiled native addon.
RUN pnpm prune --prod

# --- Runtime: Node + the pinned beets bridge and its plugin-chain binaries (design D2/D6) --------
# python3 runs the stateless bridge; the venv pins beets (src/adapters/beets/bridge/
# requirements.txt — the contract-tested version); ffmpeg (replaygain's ffmpeg backend, format
# probing), fpcalc from libchromaprint-tools (chroma), oggz-tools + opus-tools (badfiles) let the
# user's plugin chain run unmodified.
FROM node:24.18.0-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 python3-venv ffmpeg libchromaprint-tools oggz-tools opus-tools \
  && rm -rf /var/lib/apt/lists/*

COPY src/adapters/beets/bridge/requirements.txt /opt/beets-bridge/requirements.txt
RUN python3 -m venv /opt/beets-venv \
  && /opt/beets-venv/bin/pip install --no-cache-dir --requirement /opt/beets-bridge/requirements.txt

ENV NODE_ENV=production
# The pinned interpreter the bridge adapter spawns (overridable, 12-factor).
ENV BRIDGE_PYTHON=/opt/beets-venv/bin/python3
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Config is supplied entirely via the environment (12-factor): INTAKE_ROOT and BEETS_CONFIG are
# required; DATABASE_FILE defaults to data/events.db (mount a volume there). The HTTP API (and the
# MCP endpoint at /mcp) listens on HTTP_PORT (default 3000).
EXPOSE 3000
USER node
CMD ["node", "dist/composition/index.js"]
