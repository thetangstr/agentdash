# Design Partner Launch Readiness

**Goal:** Move the Mac mini launch candidate from code-ready to design-partner-ready.

**Launch stance:** AgentDash is the product and control plane. Hermes is the required local agent execution harness for the first MSP pilot path.

**Current code candidate:** branch `codex/msp-mac-mini-launch`, commit `8bd6c14a4`, PR #376.

## P0 Gates

These must be complete before the first design partner is asked to use the instance.

- [x] Publish launch branch.
  - Evidence: `origin/codex/msp-mac-mini-launch`.

- [x] Open launch PR.
  - Evidence: <https://github.com/thetangstr/agentdash/pull/376>.
  - Status: draft until target-machine validation passes.

- [ ] Install on the target Mac mini.
  - Command: `./docker/launchd/install.sh --with-postgres`
  - Evidence required:
    - `launchctl list | grep ai.agentdash.agent`
    - `curl -fsS http://127.0.0.1:3100/api/health`
    - `tail -50 ~/.agentdash/logs/agentdash.err` shows no startup failure.

- [ ] Verify Hermes harness on the target Mac mini.
  - Commands:
    - `which hermes`
    - `hermes setup`
    - confirm `AGENTDASH_HERMES_COMMAND=/absolute/path/to/hermes` in `~/.config/agentdash/agentdash.env`
  - Product proof:
    - one CoS reply through `AGENTDASH_DEFAULT_ADAPTER=hermes_local`
    - one agent task/wakeup/run through `hermes_local`
    - transcript visible in AgentDash.

- [ ] Verify partner network access.
  - Required:
    - Tailscale or private LAN path works from the partner machine.
    - `PAPERCLIP_PUBLIC_URL` points at the reachable Mac mini URL.
    - login works from non-localhost.
    - sign-up exposure is intentional; no public unauthenticated access path.

- [ ] Run end-to-end launch smoke.
  - Steps:
    1. `/api/health` returns healthy JSON.
    2. Founding operator signs up.
    3. Operator creates a company.
    4. Operator completes `/assess?onboarding=1`.
    5. Operator opens `/cos`.
    6. CoS returns a real Hermes-backed reply.
    7. Operator creates one test agent and one test task.
    8. Agent run completes and appears in the transcript.

## P1 Gates

These should be complete before week-one usage expands beyond the initial operator.

- [ ] Backup and rollback rehearsal.
  - Run one manual database backup.
  - Confirm backup file exists under `~/.agentdash/instances/default/data/backups`.
  - Record deployed SHA.
  - Rehearse rollback command sequence without destroying data.
  - Confirm non-database assets are included in the backup procedure:
    - `~/.config/agentdash/agentdash.env`
    - `~/.agentdash/instances/default/data/storage`
    - `~/.agentdash/instances/default/secrets/master.key`
    - `~/.agentdash/data/postgres` when using Docker PostgreSQL.

- [ ] Decide billing posture.
  - Option A: managed design-partner pilot, Stripe disabled/not used.
  - Option B: Stripe configured and tested:
    - `STRIPE_SECRET_KEY`
    - `STRIPE_WEBHOOK_SECRET`
    - `STRIPE_PRO_PRICE_ID`
    - checkout/webhook test confirms company tier update.

- [ ] Decide email posture.
  - Option A: direct/manual invites and password reset handled by operator.
  - Option B: Resend configured and tested:
    - `RESEND_API_KEY`
    - `AGENTDASH_EMAIL_FROM`
    - invite/welcome/password reset email reaches the partner.

- [ ] Security pass.
  - Rotate any secrets created during testing.
  - Confirm `~/.config/agentdash/agentdash.env` is mode `600`.
  - Confirm only intended users have Mac mini user account access.
  - Confirm Tailscale ACLs/private network exposure are correct.
  - Confirm logs do not expose secrets.

- [ ] Partner success operating plan.
  - Define week-one workflows:
    - Ticket Concierge
    - Daily MSP Ops Briefing
    - Client Value Report
  - Define issue-reporting channel and response SLA.
  - Define daily check-in owner and time.
  - Define data boundaries: what client data is allowed during the pilot.
  - Define success metrics:
    - time to first useful CoS response
    - number of tickets triaged
    - agent run success rate
    - operator time saved estimate
    - partner-reported trust/friction notes.

## Current Local Verification

Completed on the launch candidate before PR:

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- focused Hermes/launchd/onboard Vitest suites
- `bash -n docker/launchd/install.sh`
- isolated local TSX server smoke against `/api/health` and `/`.

## External Blockers

These cannot be completed from the local checkout alone:

- target Mac mini shell access
- Hermes credentials/session on that Mac mini
- partner Tailscale/LAN device access
- Stripe and Resend production/test account decisions
- operator confirmation of design-partner kickoff cadence.
