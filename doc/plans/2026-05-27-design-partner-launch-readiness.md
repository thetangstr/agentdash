# Design Partner Launch Readiness

**Goal:** Move the Mac mini launch candidate from code-ready to design-partner-ready.

**Launch stance:** AgentDash is the product and control plane. Hermes is the required local agent execution harness for the first MSP pilot path.

**Current code candidate:** branch `codex/msp-mac-mini-launch`, PR #376. The PR head is the launch candidate.

**Current target audit:** `doc/plans/2026-05-27-target-mac-mini-audit.md`. The target Mac mini checkout is clean on branch `codex/msp-mac-mini-launch`; the runtime-critical Hermes/launchd fix landed in `f379ce25887fd69b64f347a3f027a3d1c2187d51`, and the latest target readiness hardening evidence was collected at `cd47db96bd72d3f471f3f381107b45649640e763`.

## P0 Gates

These must be complete before the first design partner is asked to use the instance.

- [x] Publish launch branch.
  - Evidence: `origin/codex/msp-mac-mini-launch`.

- [x] Open launch PR.
  - Evidence: <https://github.com/thetangstr/agentdash/pull/376>.
  - Status: draft until partner-device access proof, GitHub token rotation confirmation, and named operator ownership are captured.

- [x] Install on the target Mac mini.
  - Command: `bash ./docker/launchd/install.sh` after starting Homebrew PostgreSQL 17.
  - Evidence:
    - SSH access confirmed for `maxiaoer@192.168.86.48`.
    - Launch checkout `/Users/maxiaoer/workspace/agentdash_msp_launch` is clean on branch `codex/msp-mac-mini-launch`.
    - `launchctl list | grep ai.agentdash.agent` shows the service loaded.
    - `curl -fsS http://127.0.0.1:3100/api/health` returns authenticated/ready health.
    - `scripts/msp-mac-mini-readiness.sh --run-instance-backup --base-url http://192.168.86.48:3100` exits with `29 pass, 12 warn, 0 fail`.
    - Docker was unavailable during cutover; Homebrew PostgreSQL 17 is running the production database.

- [x] Verify Hermes harness on the target Mac mini.
  - Commands:
    - `which hermes` or use the known absolute command path `/Users/maxiaoer/.local/bin/hermes`
    - `hermes setup`
    - confirm `AGENTDASH_HERMES_COMMAND=/absolute/path/to/hermes` in `~/.config/agentdash/agentdash.env`
    - `scripts/msp-mac-mini-readiness.sh` reports Hermes command wiring as pass.
  - Product proof:
    - CoS reply routed through `AGENTDASH_DEFAULT_ADAPTER=hermes_local` and `/Users/maxiaoer/.local/bin/hermes`.
    - Manual wakeup run `20e65705-8868-45bd-b72f-688e9c3672f0` succeeded with exit code `0`.
    - Assigned issue-write run `75181d3f-655e-4939-b94d-a5fae645cb33` succeeded with liveness `completed`.
    - Smoke issue `AGE-1` was marked `done`.
    - Hermes wrote the comment `Hermes issue-write smoke completed`.

- [ ] Verify partner network access.
  - Required:
    - Tailscale or private LAN path works from the partner machine.
    - `PAPERCLIP_PUBLIC_URL` points at the reachable Mac mini URL.
    - login works from non-localhost.
    - sign-up exposure is intentional; no public unauthenticated access path.
    - capture `scripts/msp-mac-mini-readiness.sh --base-url <partner-visible-url>` output.
  - Current evidence:
    - `PAPERCLIP_PUBLIC_URL=http://192.168.86.48:3100`.
    - LAN health from this operator machine passes.
  - Remaining:
    - partner-device login proof.
    - Tailscale install/ACL proof if LAN is not the chosen private path.

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
  - Current evidence:
    - API-level bootstrap/signup/onboarding smoke completed.
    - CoS Hermes chat smoke completed.
    - Assigned issue-write Hermes agent smoke completed.
  - Remaining:
    - human/browser proof from the partner-visible URL, including `/assess?onboarding=1` if that is still required for the pilot script.

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
  - Completed:
    - Latest manual database backup created: `/Users/maxiaoer/.agentdash/instances/default/data/backups/paperclip-20260527-140344.sql.gz`.
    - Instance-file backup archive created on target: `/Users/maxiaoer/.agentdash/instances/default/data/backups/agentdash-instance-files-20260527T220254Z.tgz`.
    - Runtime-critical deployed SHA recorded: `f379ce25887fd69b64f347a3f027a3d1c2187d51`.
    - Latest target readiness hardening SHA recorded: `cd47db96bd72d3f471f3f381107b45649640e763`.
    - Non-destructive rollback precheck passed: target checkout is clean, launchd is loaded, latest backup exists, env mode is `600`, and local health is ready.
    - Rollback runbook added: `doc/plans/2026-05-27-mac-mini-rollback-runbook.md`.
  - Remaining:
    - execute the rollback command during a maintenance window only if rollback becomes necessary.
    - rerun instance-file backup after storage or local secret material exists.

- [x] Decide billing posture.
  - Decision: managed design-partner pilot; Stripe is disabled/not used for week one.
  - Revisit Stripe setup only before self-serve billing or paid expansion:
    - `STRIPE_SECRET_KEY`
    - `STRIPE_WEBHOOK_SECRET`
    - `STRIPE_PRO_PRICE_ID`
    - checkout/webhook test confirms company tier update.

- [x] Decide email posture.
  - Decision: direct/manual invites and password reset handled by the operator for week one.
  - Revisit Resend setup only before broader user rollout:
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
  - Completed:
    - target git remote sanitized.
    - readiness secret scan passes.
    - env file mode is `600`.
    - readiness git remote credential check passes.
    - normal local macOS user inventory shows only `maxiaoer 501`.
    - temporary smoke board API key revoked; post-revoke check returned `401`.
  - Remaining:
    - rotate any GitHub token previously embedded in target git config.
    - confirm `maxiaoer` is the intended operator Mac account for partner launch.
    - confirm partner private-network exposure.

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

Completed in PR CI on CI/browser-suite proof commit `fdbb150dfb76736d8a78b702e54d01259730ce23` and revalidated on later launch-readiness heads through PR #376:

- `check`
- `audit`
- `drift`
- `policy`
- `verify` in `17m03s`
- `e2e` in `2m35s`
- Vercel
- Vercel Preview Comments

Completed on the target Mac mini without mutating the current `3100` runtime:

- SSH reachability and read-only health audit.
- `pnpm install --frozen-lockfile` in isolated checkout `/Users/maxiaoer/workspace/agentdash_msp_launch`.
- `pnpm build` in isolated checkout at commit `93ad33590a21ed7fdd2d4355735298e250fea23f`.
- `scripts/msp-mac-mini-readiness.sh` read-only pre-cutover check, expected NOT READY.

Completed on the target Mac mini after cutover:

- Launchd service installed and loaded from `/Users/maxiaoer/workspace/agentdash_msp_launch`.
- `pnpm build` passed during launchd installer at `f379ce25887fd69b64f347a3f027a3d1c2187d51`.
- Target checkout fast-forwarded cleanly on branch `codex/msp-mac-mini-launch`.
- Health passed locally and over LAN.
- `scripts/msp-mac-mini-readiness.sh --run-instance-backup --base-url http://192.168.86.48:3100` returned `29 pass, 12 warn, 0 fail`.
- `scripts/msp-mac-mini-readiness.sh --run-backup --base-url http://192.168.86.48:3100` created a database backup.
- `scripts/msp-mac-mini-readiness.sh --run-instance-backup --base-url http://192.168.86.48:3100` created an on-host instance-file backup archive.
- Hermes CoS chat proof passed.
- Hermes assigned issue-write proof passed.

## External Blockers

These cannot be completed from the local checkout alone:

- partner Tailscale/LAN device access
- partner-device login proof from the chosen private URL
- GitHub token rotation confirmation for any token that may have appeared in the target git config
- operator confirmation of design-partner kickoff cadence and named owners.
