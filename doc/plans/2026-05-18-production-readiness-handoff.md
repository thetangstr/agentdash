# Production Readiness Handoff

Date: 2026-05-18

## Current State

Active branch: `codex/invite-token-primitives`

Local head:

```text
20d0a4611761f512b4acde6dfd8ef95cd31c6b5f Make the Docker image a runnable distribution
```

Remote PR head:

```text
3858878d27cad5aa52a7d1ec5ec38b7833ee5035 Make target-test PR comments use issue comments
```

The local branch is seven commits ahead of `origin/codex/invite-token-primitives`.
GitHub PR checks are green for the older remote head only. The current local
production-readiness commits still need to be pushed before GitHub CI, target
machine tests, canary release, stable release, or production deployment can
prove this head.

The local worktree is clean except for the existing untracked `.claire/`
directory, which belongs to a separate workspace and should not be deleted by
release cleanup or handoff automation.

## Local Evidence Collected

The following checks have passed on local head `20d0a461`:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
./scripts/docker-build-test.sh
./scripts/release.sh stable --date 2026-05-22 --dry-run --skip-verify
pnpm exec vitest run server/src/__tests__/run-healer.test.ts
node --test scripts/ci/file-target-test-issue.test.mjs
node --check scripts/ci/run-target-test-profile.mjs
node --check scripts/ci/file-target-test-issue.mjs
node cli/dist/index.js --version
node cli/dist/index.js setup --help
```

Observed narrow results from the latest continuation:

- `server/src/__tests__/run-healer.test.ts`: 5 tests passed.
- `scripts/ci/file-target-test-issue.test.mjs`: 5 tests passed.
- `node cli/dist/index.js --version`: `0.3.1`.
- `agentdash setup --help` exposes `adapter`, `server`, and `bootstrap`
  subcommands.

## Fixed Locally, Not Yet Proven Remotely

- #349: release workflow/docs now target `main`; stable dry-run passes locally.
- #348: release cadence has the weekly Friday stable train and canary-on-main
  path documented and wired locally.
- #347: launchd install now writes the wrapper it references, exports sourced
  env, generates missing auth secrets, and disables the known broken legacy
  plist case.
- #345: target-machine automation now records richer diagnostics and PR target
  test comments; the original mainline Vitest failure had no stack trace.
- #297: run-healer eligibility scanner now has embedded Postgres integration
  coverage.
- #215: Docker image and npm release packaging have local smoke evidence. The
  actual published `agentdash@latest` and `ghcr.io/thetangstr/agentdash:latest`
  paths remain unproven until the release pipeline publishes this head.

## Remaining External Gates

These steps are required before calling the app production ready:

1. Push `codex/invite-token-primitives` so PR #344 points at
   `20d0a4611761f512b4acde6dfd8ef95cd31c6b5f`.
2. Wait for PR #344 checks on the pushed head:
   - Agents MD Drift Check
   - Hermes PR Audit
   - Hermes Prompt Drift Check
   - PR policy
   - PR verify
   - PR e2e
   - target-test
   - target-test-comment
   - Docker workflow
3. Register or confirm the self-hosted target runner and repository variable
   `AGENTDASH_TARGET_RUNNER_LABELS` if real target-machine coverage is required.
   Without that variable, the target workflow falls back to GitHub-hosted
   Ubuntu runners.
4. Merge the PR to `main`.
5. Let the canary workflow publish from `main` and pass release smoke against
   `agentdash@canary`.
6. Run the stable release workflow for `2026-05-22` with `dry_run=true`, then
   with `dry_run=false` after approval and npm/GitHub release credentials are
   available.
7. Confirm published package and image surfaces:
   - `npm view agentdash@latest version`
   - `npx agentdash@latest setup --help`
   - `docker run ghcr.io/thetangstr/agentdash:latest`
   - `gh workflow run release-smoke.yml -f paperclip_version=latest`
8. Deploy the cloud container with the production env vars from `doc/LAUNCH.md`:
   - `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
   - `PAPERCLIP_DEPLOYMENT_EXPOSURE=public`
   - `PAPERCLIP_AUTH_PUBLIC_BASE_URL`
   - `BETTER_AUTH_SECRET`
   - `DATABASE_URL`
   - `PAPERCLIP_MIGRATION_AUTO_APPLY=true`
   - Stripe vars
   - LLM dispatch vars
   - Resend vars
   - Agent Research vars, if launch scope includes assessments
9. Run the launch smoke from `doc/LAUNCH.md` against the deployed URL:
   sign-up, CoS welcome/interview, billing checkout, Stripe webhook, and plan
   tier transition.

## Target Machine Agent Prompt

Use this after the branch is pushed:

```text
You are validating AgentDash production readiness on a target machine.

Repository: https://github.com/thetangstr/agentdash.git
Target ref: codex/invite-token-primitives
Expected commit: 20d0a4611761f512b4acde6dfd8ef95cd31c6b5f

1. Fetch the target ref and verify HEAD is the expected commit.
2. Install Node 24 and pnpm 9.15.4.
3. Run:
   pnpm install --frozen-lockfile
   pnpm -r typecheck
   pnpm test:run
   pnpm build
4. Run browser/UAT coverage:
   npx playwright install --with-deps chromium
   PAPERCLIP_E2E_SKIP_LLM=true \
   AGENTDASH_DEEP_INTERVIEW_ASSESS=true \
   AGENTDASH_ALLOW_MULTI_COMPANY=true \
   AGENTDASH_RATE_LIMIT_DISABLED=true \
   AGENTDASH_ADAPTER_ENV_BYPASS=true \
   pnpm run test:e2e
5. Run release packaging checks:
   ./scripts/docker-build-test.sh
   ./scripts/release.sh stable --date 2026-05-22 --dry-run
6. If testing published artifacts after release:
   PAPERCLIPAI_VERSION=latest pnpm run test:target:release-smoke

For every failure, file or update a GitHub issue with the command, commit,
machine metadata, first failing test, stack trace, and artifact links. Search
for an existing target-machine-test issue before creating a duplicate.
```

## Stop Condition

The app is production ready only when local checks, PR checks on the current
head, target-machine validation, canary release smoke, stable release smoke,
published artifact install smoke, and deployed launch smoke all pass. Until
then, the production-readiness goal remains active.
