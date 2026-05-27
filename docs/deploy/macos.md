---
title: macOS Native Deployment
summary: Run AgentDash as a native macOS launchd service on a Mac mini
---

This guide covers the MSP/local-server path: one Mac mini, private access over Tailscale or LAN, a real signed-in operator, and a launchd service that restarts AgentDash after crashes or reboots.

For this deployment, use `authenticated/private`, not `local_trusted`, unless the app is only ever opened on the Mac mini itself.

## Prerequisites

- macOS with Node.js 20+ and pnpm 9+
- Git
- Either Docker for the managed PostgreSQL option, or an already-running PostgreSQL 14+ server
- Optional but recommended: Tailscale
- Hermes CLI installed and configured with `hermes setup`. For this MSP pilot path, Hermes is the local agent execution harness under AgentDash.

## Managed Install

From the checkout you want to run in production:

```sh
git clone https://github.com/thetangstr/agentdash.git ~/agentdash
cd ~/agentdash

# Recommended: start and use a local PostgreSQL 17 Docker container.
./docker/launchd/install.sh --with-postgres

# Or, if PostgreSQL is already running at DATABASE_URL in the env file:
./docker/launchd/install.sh
```

The installer:

- runs `pnpm install --frozen-lockfile`
- runs `pnpm build`
- creates `~/.config/agentdash/agentdash.env` on first install
- installs `~/Library/LaunchAgents/ai.agentdash.agent.plist`
- runs the service from the checkout with `pnpm --filter @paperclipai/server exec tsx src/index.ts`

If Hermes is on PATH during install, the env file records its absolute path in `AGENTDASH_HERMES_COMMAND`. If not, install Hermes later, run `hermes setup`, and set that variable manually before the design partner uses the instance.

## Required Env Review

Open the env file after install:

```sh
nano ~/.config/agentdash/agentdash.env
```

Minimum production-pilot settings:

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated
NODE_ENV=production
PAPERCLIP_DEPLOYMENT_EXPOSURE=private
PAPERCLIP_BIND=tailnet              # or loopback for same-machine only
PAPERCLIP_TAILNET_BIND_HOST=<tailscale-ip>
PAPERCLIP_PUBLIC_URL=http://<tailscale-ip>:3100
PAPERCLIP_MIGRATION_AUTO_APPLY=true
BETTER_AUTH_SECRET=<generated-secret>
PAPERCLIP_AGENT_JWT_SECRET=<generated-secret>
AGENTDASH_DEFAULT_ADAPTER=hermes_local
AGENTDASH_HERMES_COMMAND=/absolute/path/to/hermes
```

`hermes_local` is the default local harness for this pilot: AgentDash remains the product/control plane, while Hermes executes local agent work and can power CoS chat when selected.

Optional launch integrations:

```sh
ANTHROPIC_API_KEY=sk-ant-...
RESEND_API_KEY=re_...
AGENTDASH_EMAIL_FROM='AgentDash <noreply@example.com>'
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_PRICE_ID=price_...
BILLING_PUBLIC_BASE_URL=http://<tailscale-ip>:3100
```

Restart after changing the env file:

```sh
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
```

## Service Commands

```sh
# Logs
tail -f ~/.agentdash/logs/agentdash.log
tail -f ~/.agentdash/logs/agentdash.err

# Health
curl -fsS http://127.0.0.1:3100/api/health

# Stop
launchctl unload ~/Library/LaunchAgents/ai.agentdash.agent.plist

# Start
launchctl load ~/Library/LaunchAgents/ai.agentdash.agent.plist

# Restart
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent

# Uninstall service only; data is preserved.
./docker/launchd/install.sh --uninstall
```

## Launch Smoke

Run this before putting MSP users on the instance:

1. `curl -fsS http://127.0.0.1:3100/api/health` returns healthy JSON.
2. Open `PAPERCLIP_PUBLIC_URL` from another machine on the tailnet or LAN.
3. Sign up with the founding operator account.
4. Complete `/company-create -> /assess?onboarding=1 -> /cos`.
5. Send one CoS message and confirm the reply is real, not the Anthropic stub string.
6. Create one test company/agent/task using `hermes_local`.
7. Confirm one agent wakeup/run exits successfully and appears in the dashboard transcript.
8. If billing is enabled, run one Stripe checkout/webhook test and confirm the company tier updates.

## Update

```sh
cd ~/agentdash
git fetch origin
git checkout main
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
curl -fsS http://127.0.0.1:3100/api/health
```

Record the deployed SHA:

```sh
git rev-parse HEAD
```

## Rollback

```sh
cd ~/agentdash
git checkout <previous-good-sha>
pnpm install --frozen-lockfile
pnpm build
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
curl -fsS http://127.0.0.1:3100/api/health
```

Do not roll back across migrations after customer data has changed unless you have a tested database restore point.

## Backups

Back up all of these for full local-instance disaster recovery:

- `~/.config/agentdash/agentdash.env`
- `~/.agentdash/instances/default/data/backups`
- `~/.agentdash/instances/default/data/storage`
- `~/.agentdash/instances/default/secrets/master.key`
- `~/.agentdash/data/postgres` when using the Docker PostgreSQL option
- the deployed checkout SHA from `~/agentdash`

Database logical backups alone are not enough: uploads, workspaces, and the local encrypted secrets key live outside the database.
