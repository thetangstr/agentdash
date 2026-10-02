---
title: Environment variables
summary: The environment variables a self-hosted AgentDash server reads, and the ones it injects into agent runs
---

Most server settings can come from the instance config file or the environment; the environment wins. Many names still start with `PAPERCLIP_`. They are the real names, so use them exactly as written.

The server also loads two `.env` files at startup, without overriding anything already set: the one next to the instance config (`~/.paperclip/instances/default/.env` by default) and `.env` in the working directory. Source: `server/src/config.ts`.

This page lists the settings a self-hoster needs. Each was checked against the code; the file is named in each section.

## Server and network

Source: `server/src/config.ts`, `server/src/home-paths.ts`, `server/src/paths.ts`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3100` | Listen port. If it is taken, the server picks the next free one |
| `PAPERCLIP_BIND` | inferred from `HOST` | `loopback`, `lan`, `tailnet` or `custom`. See [Deployment modes](/deploy/deployment-modes) |
| `PAPERCLIP_BIND_HOST` | (unset) | Address to listen on when `PAPERCLIP_BIND=custom` |
| `PAPERCLIP_TAILNET_BIND_HOST` | from `tailscale ip -4` | Address to listen on when `PAPERCLIP_BIND=tailnet` |
| `HOST` | `127.0.0.1` | Older way to set the listen address. Prefer `PAPERCLIP_BIND` |
| `SERVE_UI` | `true` | Serve the web UI from the API server |
| `PAPERCLIP_HOME` | `~/.paperclip` | Root directory for all instance data |
| `PAPERCLIP_INSTANCE_ID` | `default` | Instance name under `PAPERCLIP_HOME/instances/`. Letters, digits, `-` and `_` |
| `PAPERCLIP_CONFIG` | `<instance>/config.json` | Path to the instance config file |

## Mode and sign-in

Source: `server/src/config.ts`, `server/src/auth/better-auth.ts`, `server/src/agent-auth-jwt.ts`, `server/src/lib/signup-gate.ts`.

| Variable | Default | Meaning |
|---|---|---|
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` | `local_trusted` or `authenticated` |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | `private` or `public`. Ignored in `local_trusted` |
| `PAPERCLIP_AUTH_BASE_URL_MODE` | `explicit` if a public URL is set, else `auto` | How the auth base URL is chosen |
| `BETTER_AUTH_SECRET` | (none) | Session signing secret. Required in `authenticated` mode |
| `PAPERCLIP_AGENT_JWT_SECRET` | `BETTER_AUTH_SECRET` | Secret for signing agent run tokens |
| `PAPERCLIP_AGENT_JWT_TTL_SECONDS` | `172800` (48 hours) | Lifetime of an agent run token |
| `PAPERCLIP_AUTH_DISABLE_SIGN_UP` | `false` | `true` turns off new account sign-up |
| `AGENTDASH_SELF_SERVE_BOOTSTRAP` | `false` | `true` makes the first user to create a company the instance admin. See [First admin](/deploy/deployment-modes) |
| `PAPERCLIP_ENABLE_COMPANY_DELETION` | `true` in `local_trusted`, else `false` | Allow deleting a company |

## Public URLs and origins

Source: `server/src/lib/declared-origins.ts`, `.env.example`.

| Variable | Meaning |
|---|---|
| `PAPERCLIP_PUBLIC_URL` | The URL people open. Used for the auth base URL, invite links, and the hostname allowlist |
| `PAPERCLIP_ALLOWED_HOSTNAMES` | Extra hostnames allowed in `private` exposure, comma-separated |
| `PAPERCLIP_CANONICAL_ORIGIN` | With more than one address: the one origin used in links read outside a request (emails, approval links, MCP results, the OAuth issuer). Also reported as `canonicalOrigin` on `/api/health` |
| `PAPERCLIP_ORIGINS` | With more than one address: every origin browsers arrive on, comma-separated, each with scheme and port |
| `PAPERCLIP_AUTH_PUBLIC_BASE_URL`, `BETTER_AUTH_URL` | Older ways to set the auth base URL |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Older way to add trusted origins, comma-separated |
| `PAPERCLIP_API_URL` | Base URL that agent processes use to call the API. Defaults to the server's own listen address; set it when that differs from what agents should use |

When `PAPERCLIP_CANONICAL_ORIGIN` or `PAPERCLIP_ORIGINS` is set, the declared origins become the trusted-origin list, and the older variables are folded into it. With neither set, behavior is unchanged.

The config file's `auth.publicBaseUrl` (what `agentdash onboard` writes) names the same address with lower precedence: `PAPERCLIP_CANONICAL_ORIGIN`, `PAPERCLIP_PUBLIC_URL`, then `PAPERCLIP_AUTH_PUBLIC_BASE_URL` / `BETTER_AUTH_URL` / `BETTER_AUTH_BASE_URL`, then the config file, then the first `PAPERCLIP_ORIGINS` entry. In declared mode the declared canonical always mints links — an alias or the config-file value stays trusted for sign-in but is never the canonical address.

## Database

Source: `server/src/config.ts`, `server/src/index.ts`. Details: [Database](/deploy/database).

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | (unset: embedded PostgreSQL) | PostgreSQL connection string |
| `DATABASE_MIGRATION_URL` | `DATABASE_URL` | Connection string used for migrations only |
| `PAPERCLIP_MIGRATION_AUTO_APPLY` | (unset) | `true` applies pending migrations at startup without asking. Unset, the server asks on an interactive terminal and applies them anyway when there is no terminal (Docker, launchd) |
| `PAPERCLIP_MIGRATION_PROMPT` | (unset) | `never` refuses to start with pending migrations, unless auto-apply is on |
| `PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE` | `false` | Log embedded PostgreSQL output |
| `PAPERCLIP_DB_BACKUP_ENABLED` | `true` | Scheduled database backups |
| `PAPERCLIP_DB_BACKUP_INTERVAL_MINUTES` | `60` | Backup interval |
| `PAPERCLIP_DB_BACKUP_RETENTION_DAYS` | `7` | Backup retention |
| `PAPERCLIP_DB_BACKUP_DIR` | `<instance>/data/backups` | Backup directory |

## Storage and secrets

- Storage: `PAPERCLIP_STORAGE_PROVIDER`, `PAPERCLIP_STORAGE_LOCAL_DIR`, `PAPERCLIP_STORAGE_S3_BUCKET`, `PAPERCLIP_STORAGE_S3_REGION`, `PAPERCLIP_STORAGE_S3_ENDPOINT`, `PAPERCLIP_STORAGE_S3_PREFIX`, `PAPERCLIP_STORAGE_S3_FORCE_PATH_STYLE`, `PAPERCLIP_ATTACHMENT_MAX_BYTES`, `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES`. See [Storage](/deploy/storage).
- Secrets: `PAPERCLIP_SECRETS_PROVIDER`, `PAPERCLIP_SECRETS_MASTER_KEY`, `PAPERCLIP_SECRETS_MASTER_KEY_FILE`, `PAPERCLIP_SECRETS_STRICT_MODE`. See [Secrets](/deploy/secrets).

## Scheduler

Source: `server/src/config.ts`. See [Heartbeats and runs](/concepts/heartbeats-and-runs).

| Variable | Default | Meaning |
|---|---|---|
| `HEARTBEAT_SCHEDULER_ENABLED` | `true` | `false` stops the heartbeat scheduler |
| `HEARTBEAT_SCHEDULER_INTERVAL_MS` | `30000` | Scheduler tick, at least `10000` |

## Agents and adapters

| Variable | Meaning | Source |
|---|---|---|
| `AGENTDASH_DEFAULT_ADAPTER` | The instance's default adapter, used for Chief of Staff chat and for agents created during onboarding. The fallback when unset differs between code paths, so set it. The Docker image sets `hermes_local` | `server/src/services/dispatch-llm.ts`, `server/src/services/onboarding-orchestrator.ts` |
| `AGENTDASH_HERMES_COMMAND` | Path to the `hermes` binary, if it is not on `PATH` | `server/src/adapters/registry.ts` |
| `AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT` | `true` blocks launching an agent until its adapter environment test has passed | `server/src/services/agent-harness-preflight-readiness.ts` |
| `ANTHROPIC_API_KEY` | Anthropic key the server uses for the `claude_api` chat adapter | `server/src/services/anthropic-llm.ts` |
| `OPENAI_API_KEY` | OpenAI key the server uses to list Codex models | `server/src/adapters/codex-models.ts` |

## Email

Source: `server/src/auth/email.ts`. Without `RESEND_API_KEY`, no email is sent: an invite or password-reset request succeeds, but the link is never delivered, and the server logs that it skipped the email (info level).

| Variable | Default | Meaning |
|---|---|---|
| `RESEND_API_KEY` | (unset) | Resend API key. Required to send email |
| `AGENTDASH_EMAIL_FROM` | `AgentDash <onboarding@resend.dev>` | Sender. Use your own verified domain in production |
| `AGENTDASH_EMAIL_REPLY_TO` | (unset) | Reply-To address |

Server variables are not passed to agent runs. A spawned agent gets a short allowlist (`PATH`, `HOME`, locale, temp directories, `HERMES_*` and a few more), the variables below, and its own adapter `env`. Give an agent a provider key through its adapter `env`, ideally as a secret reference. Source: `inheritableAdapterEnv` in `packages/adapter-utils/src/server-utils.ts`.

## Set for agent processes

The server sets these in the environment of every agent run. You do not set them yourself. Source: `packages/adapter-utils/src/server-utils.ts`, `packages/adapters/*/src/server/execute.ts`.

| Variable | Meaning |
|---|---|
| `PAPERCLIP_AGENT_ID` | The agent's id |
| `PAPERCLIP_COMPANY_ID` | The agent's company id |
| `PAPERCLIP_API_URL` | API base URL for this run |
| `PAPERCLIP_API_KEY` | Agent API token for this run (a signed JWT) |
| `PAPERCLIP_RUN_ID` | The heartbeat run id. Send it back as the `X-Paperclip-Run-Id` header |
| `PAPERCLIP_TASK_ID` | The issue that woke the agent, if any |
| `PAPERCLIP_WAKE_REASON` | Why the agent was woken |
| `PAPERCLIP_WAKE_COMMENT_ID` | The comment that woke the agent, if any |
| `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS` | The approval that was resolved, and its decision |
| `PAPERCLIP_LINKED_ISSUE_IDS` | Linked issue ids, comma-separated |
| `PAPERCLIP_WORKSPACE_CWD` and other `PAPERCLIP_WORKSPACE_*` | The run's execution workspace (path, source, strategy, repository, branch) |

The `@agentdash/mcp-server` package reads `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY`, and also accepts `AGENTDASH_API_URL` and `AGENTDASH_API_KEY` as aliases. Source: `packages/mcp-server/src/config.ts`.
