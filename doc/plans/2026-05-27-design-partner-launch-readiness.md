# Design Partner Launch Readiness

**Goal:** Move the Mac mini launch candidate from code-ready to design-partner-ready.

**Launch stance:** AgentDash is the product and control plane. Hermes is the required local agent execution harness for the first MSP pilot path.

**Current code candidate:** branch `codex/msp-mac-mini-launch`, PR #376. The PR head is the launch candidate.

**Current target audit:** `doc/plans/2026-05-27-target-mac-mini-audit.md`. The target Mac mini is reachable and the PR branch builds there, but the live `3100` service is still a dev-runner from an existing checkout. It is not yet the launchd production install.

## P0 Gates

These must be complete before the first design partner is asked to use the instance.

- [x] Publish launch branch.
  - Evidence: `origin/codex/msp-mac-mini-launch`.

- [x] Open launch PR.
  - Evidence: <https://github.com/thetangstr/agentdash/pull/376>.
  - Status: draft until target-machine validation passes.

- [ ] Install on the target Mac mini.
  - Command: `./docker/launchd/install.sh --with-postgres`
  - Current target evidence:
    - SSH access confirmed for `maxiaoer@192.168.86.48`.
    - Isolated launch checkout `/Users/maxiaoer/workspace/agentdash_msp_launch` builds at `93ad33590a21ed7fdd2d4355735298e250fea23f`.
    - Existing `3100` health check passes, but from a dev-runner process rather than launchd.
    - `scripts/msp-mac-mini-readiness.sh` exits NOT READY before cutover because launchd/env/Hermes/private URL are not configured.
  - Evidence required:
    - `launchctl list | grep ai.agentdash.agent`
    - `curl -fsS http://127.0.0.1:3100/api/health`
    - `tail -50 ~/.agentdash/logs/agentdash.err` shows no startup failure.
    - `scripts/msp-mac-mini-readiness.sh` exits with no P0 failures after install.

- [ ] Verify Hermes harness on the target Mac mini.
  - Commands:
    - `which hermes` or use the known absolute command path `/Users/maxiaoer/.local/bin/hermes`
    - `hermes setup`
    - confirm `AGENTDASH_HERMES_COMMAND=/absolute/path/to/hermes` in `~/.config/agentdash/agentdash.env`
    - `scripts/msp-mac-mini-readiness.sh` reports Hermes command wiring as pass.
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
    - capture `scripts/msp-mac-mini-readiness.sh --base-url <partner-visible-url>` output.

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
  - Run one manual database backup with `scripts/msp-mac-mini-readiness.sh --run-backup`.
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
  - Rotate any GitHub token that may have been embedded in target git config before the sanitized remote update.
  - Confirm `~/.config/agentdash/agentdash.env` is mode `600`.
  - Confirm only intended users have Mac mini user account access.
  - Confirm Tailscale ACLs/private network exposure are correct.
  - Confirm logs do not expose secrets.
  - Evidence: `scripts/msp-mac-mini-readiness.sh` security/log checks pass.

- [x] Partner success operating plan prepared.
  - Evidence: `doc/plans/2026-05-27-msp-design-partner-operating-plan.md`.
  - Still required before usage expands: fill in named partner/operator owners and confirm the issue channel/check-in time with the design partner.

## Current Local Verification

Completed on the launch candidate before PR:

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- focused Hermes/launchd/onboard Vitest suites
- `bash -n docker/launchd/install.sh`
- `bash -n scripts/msp-mac-mini-readiness.sh`
- isolated local TSX server smoke against `/api/health` and `/`.

Completed on the target Mac mini without mutating the current `3100` runtime:

- SSH reachability and read-only health audit.
- `pnpm install --frozen-lockfile` in isolated checkout `/Users/maxiaoer/workspace/agentdash_msp_launch`.
- `pnpm build` in isolated checkout at commit `93ad33590a21ed7fdd2d4355735298e250fea23f`.
- `scripts/msp-mac-mini-readiness.sh` read-only pre-cutover check, expected NOT READY.

## External Blockers

These cannot be completed from the local checkout alone or should wait for a controlled cutover window:

- Hermes credentials/session on that Mac mini
- partner Tailscale/LAN device access
- replacing the active `3100` dev-runner with the launchd production service
- Stripe and Resend production/test account decisions
- operator confirmation of design-partner kickoff cadence.
