---
title: Docker
summary: Run AgentDash in Docker, with embedded PostgreSQL or a PostgreSQL container
---

Run AgentDash in a container without installing Node or pnpm. Run every command from the root of a clone of https://github.com/thetangstr/agentdash.

The image runs in `authenticated` + `private` mode, so everyone signs in. It needs `BETTER_AUTH_SECRET`. For how the first account becomes the instance admin, see [First admin](/deploy/deployment-modes). Source: `Dockerfile`, `docker/`.

## Quickstart: one container

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

Open http://localhost:3100.

- Host port: `3100`. Change it with `PAPERCLIP_PORT`.
- Data: `./data/docker-paperclip` in the clone. Change it with `PAPERCLIP_DATA_DIR`. The path is relative to the compose file, so `../data/pc` means `data/pc` at the repository root.
- Database: embedded PostgreSQL, stored in the data directory.
- If you change the port or use another hostname, set `PAPERCLIP_PUBLIC_URL` to the address you open in the browser.

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
PAPERCLIP_PORT=3200 PAPERCLIP_PUBLIC_URL=http://localhost:3200 PAPERCLIP_DATA_DIR=../data/pc \
  docker compose -f docker/docker-compose.quickstart.yml up --build
```

Keep the same `BETTER_AUTH_SECRET` across restarts, or existing sessions stop working.

## With a PostgreSQL container

`docker/docker-compose.yml` runs the server and PostgreSQL 17. The server starts after the database passes its health check.

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  docker compose -f docker/docker-compose.yml up --build
```

PostgreSQL data lives in the `pgdata` volume and AgentDash data in `paperclip-data`. The database credentials in this file are fixed development values; use the production file below for anything real.

## Production: a pinned image

`docker/docker-compose.production.yml` does not build from source. It requires:

- `AGENTDASH_IMAGE`: an image pinned to a `sha-<commit>` tag. The repository's Docker workflow publishes `sha-<7>` tags (and `latest` from `main`) to `ghcr.io/thetangstr/agentdash`. Source: `.github/workflows/docker.yml`.
- `POSTGRES_PASSWORD`, `PAPERCLIP_PUBLIC_URL` and `BETTER_AUTH_SECRET`.
- An env file for everything else, `./agentdash.env` by default (`AGENTDASH_RUNTIME_ENV_FILE` changes it).

It also turns on `PAPERCLIP_MIGRATION_AUTO_APPLY` and `AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT` by default. With the second one, an agent cannot launch until its adapter environment test has passed. See [Environment variables](/deploy/environment-variables).

Update and roll back with the updater. It runs a backup command, switches the pinned image, waits for `/api/health`, and writes a deploy receipt:

```sh
node scripts/deploy/agentdash-ota-update.mjs --help
node scripts/deploy/agentdash-ota-update.mjs --target-sha <git-sha> --image-repo ghcr.io/thetangstr/agentdash --dry-run
```

Source: `scripts/deploy/agentdash-ota-update.mjs`.

## Build and run by hand

```sh
docker build -t agentdash-local .
docker run --name agentdash \
  -p 3100:3100 \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  -v "$(pwd)/data/docker-paperclip:/paperclip" \
  agentdash-local
```

The image already sets `HOST=0.0.0.0`, `PORT=3100`, `PAPERCLIP_HOME=/paperclip`, `SERVE_UI=true` and the deployment mode. To match file ownership on a bind mount to your host user, build with `--build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g)`. At startup the entrypoint also remaps the container user to `USER_UID` / `USER_GID` if you pass them, and hands anything under `/paperclip` it does not own to that user. Source: `scripts/docker-entrypoint.sh`.

## What is persisted

Everything lives under `/paperclip` in the container (the bind mount or volume):

- the embedded PostgreSQL data, when `DATABASE_URL` is not set
- uploaded files
- the secrets master key
- agent workspaces
- Hermes state (profiles, credentials, sessions), under `/paperclip/.hermes`

Back up the whole directory. A database dump alone does not include uploads or the secrets key.

## Agent tools in the image

The image installs the `claude`, `codex`, `opencode` and `hermes` CLIs, plus `git`, `gh`, `ripgrep`, `python3` and `jq`. It sets `AGENTDASH_DEFAULT_ADAPTER=hermes_local`; override it with `-e` if you want another default.

Agent runs do not inherit the container's environment. The server passes a spawned agent only a short allowlist (`PATH`, `HOME`, locale, temp directories, `HERMES_*` and a few more) plus the agent's own configured `env`. Source: `inheritableAdapterEnv` in `packages/adapter-utils/src/server-utils.ts`. So a provider key reaches an agent in one of two ways:

- in the agent's adapter `env`, ideally as a secret reference (see [Secrets](/deploy/secrets)); or
- through the CLI's own login, stored under `HOME` (`/paperclip` in the image), which persists on the volume.

`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` set on the container are read by the server itself, for example by the `claude_api` chat adapter. See [Environment variables](/deploy/environment-variables).

Without any keys the app still runs. An adapter's environment test reports what is missing.
