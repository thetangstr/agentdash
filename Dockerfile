# syntax=docker/dockerfile:1.20
# AgentDash (#721): uv, pinned by digest, only to install Hermes from its lockfile.
FROM ghcr.io/astral-sh/uv:0.11.6@sha256:b1e699368d24c57cda93c338a57a8c5a119009ba809305cc8e86986d4a006754 AS uv_source

FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/connect/package.json packages/connect/
COPY packages/create-agentdash/package.json packages/create-agentdash/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY patches/ patches/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
# AgentDash: the server's `tsc` needs more than Node's default heap on hosts with
# ~8 GB (V8 sizes the default old space from physical memory); pin it so the image
# builds the same on a laptop Docker VM and on a 16 GB CI runner.
ENV NODE_OPTIONS=--max-old-space-size=4096
COPY --from=deps /app /app
COPY . .
# AgentDash: the UI's `tsc -b` resolves @paperclipai/adapter-utils, @paperclipai/shared
# and the adapter packages from their dist output, so the workspace packages
# must be built first. `<pkg>^...` selects a package's workspace dependencies
# (transitively, in topological order) and nothing else, so the plugin examples
# that the deps stage never installs are not touched.
# Building the UI first failed every image build from 2026-08-27 to 2026-09-01.
RUN pnpm --filter "@paperclipai/ui^..." --filter "@paperclipai/server^..." build
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

# AgentDash (#721): Hermes Agent, the only runtime on a hosted 1.0 box.
#
# Pinned to a release tag AND its commit; the build fails if the tag ever
# points elsewhere. Python dependencies come from Hermes' own uv.lock
# (`--frozen`: exact versions and sha256 hashes, no re-resolution). The
# `anthropic` extra is the one provider SDK outside core that a 1.0 provider
# (Anthropic) needs; Z.AI, OpenRouter and OpenAI use the core openai client.
#
# Upgrade path: pick a tag from https://github.com/NousResearch/hermes-agent/tags,
# set HERMES_REF and HERMES_COMMIT (`git rev-list -n1 <tag>`), rebuild, and run
# scripts/docker/hermes-smoke.sh against the image. Record the bump in the
# Railway runbook (#675).
FROM base AS hermes
ARG HERMES_REF=v2026.9.11
ARG HERMES_COMMIT=939e45c91d751fadd94dcd1b873ac3cb44846213
COPY --from=uv_source /uv /usr/local/bin/uv
ENV UV_PYTHON=/usr/bin/python3 \
  UV_PYTHON_DOWNLOADS=never \
  UV_PROJECT_ENVIRONMENT=/opt/hermes/.venv \
  UV_LINK_MODE=copy \
  UV_NO_CACHE=1
RUN git clone --depth 1 --branch "$HERMES_REF" https://github.com/NousResearch/hermes-agent.git /opt/hermes \
  && test "$(git -C /opt/hermes rev-parse HEAD)" = "$HERMES_COMMIT" \
  && rm -rf /opt/hermes/.git
WORKDIR /opt/hermes
RUN uv sync --frozen --no-dev --extra anthropic \
  && test -x /opt/hermes/.venv/bin/hermes \
  && rm -rf tests website apps contributors ui-tui node_modules nix docker evals

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

# AgentDash (#721): Hermes (source tree + venv; the install is editable, so the
# tree stays). Root-owned and read-only at runtime; Hermes state lives under
# $HOME/.hermes on the Volume.
COPY --from=hermes /opt/hermes /opt/hermes
RUN ln -s /opt/hermes/.venv/bin/hermes /usr/local/bin/hermes \
  && hermes --version

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true

# AgentDash (#721): hosted-box Hermes defaults. Everything Hermes keeps
# (profiles, provider credentials, sessions, state.db ledgers) and the
# per-agent `agentdash-<id>` wrappers live under /paperclip, the Volume mount,
# so they survive a redeploy. HERMES_HOME is deliberately NOT set: it would
# pin every run's ledger to the root state.db and hide the per-profile ledgers
# a `hermes -p <profile>` run writes. Hermes finds its root at $HOME/.hermes.
# Managed per-agent profiles and the Hermes default adapter are image defaults;
# a self-hoster can override them with `-e`. Code defaults for non-Docker
# installs are unchanged. The hosted flag itself (AGENTDASH_DEPLOYMENT_KIND=hosted)
# is set on the service, not here.
ENV AGENTDASH_HERMES_COMMAND=/usr/local/bin/hermes \
  AGENTDASH_HERMES_ROOT=/paperclip/.hermes \
  HERMES_PROFILES_DIR=/paperclip/.hermes/profiles \
  AGENTDASH_HERMES_BIN_DIR=/paperclip/.hermes/bin \
  AGENTDASH_HERMES_MANAGED_PROFILES=true \
  AGENTDASH_DEFAULT_ADAPTER=hermes_local \
  PYTHONDONTWRITEBYTECODE=1

# VOLUME ["/paperclip"] — removed for Railway (Dockerfile VOLUME unsupported; use a Railway Volume mounted at /paperclip if persistence is needed; SaaS uses external Postgres)
EXPOSE 3100

# AgentDash (#721): the container starts as root so the entrypoint can hand a
# root-owned platform Volume (Railway) to node, then drops to node via gosu.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
