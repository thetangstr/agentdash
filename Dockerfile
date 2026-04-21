# ─── Stage 1: deps ───────────────────────────────────────────────────────────
# Install all dependencies using the exact lockfile so later stages are
# cache-efficient and deterministic.
FROM node:20-alpine AS deps

ARG USER_UID=1000
ARG USER_GID=1000

# shadow  → usermod / groupmod
# gosu    → drop privileges in entrypoint
# python3 + make + g++ → native addon compilation (sharp, embedded-postgres)
RUN apk add --no-cache shadow gosu python3 make g++ && \
    corepack enable

WORKDIR /app

# Copy only manifests first so this layer is invalidated only when deps change
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/billing/package.json packages/billing/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/db/package.json packages/db/
COPY packages/plugins/create-paperclip-plugin/package.json packages/plugins/create-paperclip-plugin/
COPY packages/plugins/examples/plugin-authoring-smoke-example/package.json packages/plugins/examples/plugin-authoring-smoke-example/
COPY packages/plugins/examples/plugin-file-browser-example/package.json packages/plugins/examples/plugin-file-browser-example/
COPY packages/plugins/examples/plugin-hello-world-example/package.json packages/plugins/examples/plugin-hello-world-example/
COPY packages/plugins/examples/plugin-kitchen-sink-example/package.json packages/plugins/examples/plugin-kitchen-sink-example/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY packages/shared/package.json packages/shared/
COPY patches/ patches/

RUN pnpm install --frozen-lockfile

# ─── Stage 2: build ──────────────────────────────────────────────────────────
# Compile TypeScript and bundle the Vite UI.
FROM deps AS build

WORKDIR /app

# Bring in full source on top of the already-installed node_modules
COPY . .

RUN pnpm --filter @agentdash/ui build
RUN pnpm --filter @agentdash/plugin-sdk build
RUN pnpm --filter @agentdash/server build

# Fail fast if the server bundle is missing
RUN test -f server/dist/index.js || (echo "ERROR: server/dist/index.js not found" && exit 1)

# ─── Stage 3: runtime ────────────────────────────────────────────────────────
# Lean final image — copy only what the running server needs.
FROM node:20-alpine AS runtime

ARG USER_UID=1000
ARG USER_GID=1000

RUN apk add --no-cache shadow gosu git && \
    corepack enable && \
    # Remap the built-in 'node' user to the requested UID/GID so that the
    # /paperclip volume is always owned by the container user.
    usermod  -u "${USER_UID}" --non-unique node && \
    groupmod -g "${USER_GID}" --non-unique node && \
    usermod  -g "${USER_GID}" -d /paperclip node && \
    mkdir -p /paperclip && chown node:node /paperclip

WORKDIR /app

# Copy the complete built workspace (source + compiled artefacts + node_modules)
COPY --chown=node:node --from=build /app /app

# AgentDash (AGE-50 ops): install oh-my-claudecode into the image so the
# Chief of Staff's /deep-interview skill works on hosted deploys. We clone
# into /app/.claude rather than /paperclip/.claude because /paperclip is
# a VOLUME — anything written to it during the build is masked at runtime.
# server/src/services/omc-detection.ts resolves path (4) via
# CLAUDE_PROJECT_DIR=/app (see ENV block below).
RUN mkdir -p /app/.claude/plugins/marketplaces && \
    git clone --depth 1 https://github.com/Yeachan-Heo/oh-my-claudecode.git \
        /app/.claude/plugins/marketplaces/omc && \
    rm -rf /app/.claude/plugins/marketplaces/omc/.git && \
    chown -R node:node /app/.claude

COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    HOME=/paperclip \
    HOST=0.0.0.0 \
    PORT=3100 \
    SERVE_UI=true \
    PAPERCLIP_HOME=/paperclip \
    PAPERCLIP_INSTANCE_ID=default \
    PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
    PAPERCLIP_DEPLOYMENT_MODE=authenticated \
    PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
    CLAUDE_PROJECT_DIR=/app \
    USER_UID=${USER_UID} \
    USER_GID=${USER_GID}

# /paperclip holds embedded-postgres data, config, and agent workspaces
VOLUME ["/paperclip"]

EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
# tsx loader is required because server/dist/index.js uses dynamic imports that
# tsx resolves at runtime (workspace package resolution).
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
