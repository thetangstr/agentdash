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
PAPERCLIP_BIND=lan                  # private LAN/tailnet only; do not port-forward publicly
PAPERCLIP_ALLOWED_HOSTNAMES=<tailscale-ip>,<lan-ip>
PAPERCLIP_PUBLIC_URL=http://<tailscale-ip>:3100
PAPERCLIP_API_URL=http://127.0.0.1:3100
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
```

`PAPERCLIP_PUBLIC_URL` is the partner-visible private URL. `PAPERCLIP_API_URL` is the local write-back URL used by Hermes and other local harnesses; keep it loopback so agent API calls do not depend on partner-device routing. If you use Tailscale Serve instead, bind AgentDash to loopback and point Tailscale Serve at `http://127.0.0.1:3100`.

For the embedded Postgres install path, leave `DATABASE_URL` unset and set `PAPERCLIP_EMBEDDED_POSTGRES_PORT=54329` only if you need an explicit port. Do not keep a stale Homebrew `DATABASE_URL` in the launch env while also running embedded Postgres; that creates split-brain instances and can make launchd move to `3101` while a stale process masks `3100`.

For the private MSP Mac mini paid trial, do not rely on Stripe webhooks reaching this host. Collect payment through AgentDash-owned Stripe/customer-portal/payment-link flow, then record the launch company locally as `pro_trial` or `pro_active`. The readiness collector verifies that local entitlement for the expected company.

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

## Readiness Evidence

After install, collect one readiness artifact before inviting the design partner:

```sh
cd ~/agentdash
scripts/msp-mac-mini-readiness.sh \
  --run-backup \
  --run-instance-backup \
  --base-url http://<tailscale-or-lan-host>:3100 \
  --expected-company "AgentDash MSP Demo" \
  | tee ~/agentdash-readiness-$(date +%Y%m%d-%H%M%S).txt
```

The collector is read-only by default. It checks the launchd service, local health, core authenticated/private env values, Hermes command wiring, local agent API write-back, Tailscale/private URL posture, recent logs, backup posture, and billing/email posture. It exits nonzero when a P0 host/configuration gate fails.

For the P1 backup rehearsal, run it with the explicit backup flag:

```sh
scripts/msp-mac-mini-readiness.sh --run-backup | tee ~/agentdash-readiness-backup-$(date +%Y%m%d-%H%M%S).txt
```

If the partner-visible URL differs from `PAPERCLIP_PUBLIC_URL`, test that URL explicitly:

```sh
scripts/msp-mac-mini-readiness.sh --base-url http://<tailscale-or-lan-host>:3100
```

This script does not replace the two product proofs: a real Hermes-backed CoS reply and one completed `hermes_local` agent run with a visible transcript.

## Launch Smoke

Run this before putting MSP users on the instance:

1. `curl -fsS http://127.0.0.1:3100/api/health` returns healthy JSON.
2. Open `PAPERCLIP_PUBLIC_URL` from another machine on the tailnet or LAN.
3. Sign up with the founding operator account.
4. Complete `/company-create -> /assess?onboarding=1 -> /cos`.
5. Send one CoS message and confirm the reply is real, not the Anthropic stub string.
6. Create one test company/agent/task using `hermes_local`.
7. Confirm one agent wakeup/run exits successfully and appears in the dashboard transcript.
8. Confirm the paid trial is captured in AgentDash-owned Stripe evidence and the local launch company shows `pro_trial` or `pro_active` in `/billing`.

For the first MSP design partner, use the operating plan in [doc/plans/2026-05-27-msp-design-partner-operating-plan.md](../../doc/plans/2026-05-27-msp-design-partner-operating-plan.md) to keep week-one usage focused on human-reviewed Ticket Concierge, Daily MSP Ops Briefing, and Client Value Report workflows.

## Update

```sh
cd ~/agentdash
scripts/msp-mac-mini-readiness.sh --run-backup --run-instance-backup --base-url http://<tailscale-or-lan-host>:3100 --expected-company "AgentDash MSP Demo"
git fetch origin
git checkout <approved-release-branch-or-sha>
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
curl -fsS http://127.0.0.1:3100/api/health
scripts/msp-mac-mini-readiness.sh --base-url http://<tailscale-or-lan-host>:3100 --expected-company "AgentDash MSP Demo"
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
