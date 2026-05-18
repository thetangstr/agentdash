# Production Readiness Handoff

Date: 2026-05-18

## Current State

Active branch: `codex/invite-token-primitives`

Latest checked PR head observed during this readiness-hardening pass:

```text
03a55d32ee11e04a5f61f27662d8cd50b5fdcc31 Require controlled launch-smoke accounts before production readiness
```

This document may live on a later documentation-only commit. Resolve the current
PR head before handoff with:

```sh
gh pr view 344 --repo thetangstr/agentdash --json headRefOid,statusCheckRollup
```

Run `git rev-parse HEAD` before handing off to a remote runner, target machine,
canary release, or stable release.

The branch is pushed to PR #344. The code and CI readiness checks are green on
latest checked head `03a55d32`: PR policy, PR verify, PR e2e, target-test preflight,
target-test, target-test-comment, Docker, Agents MD drift, Hermes PR audit, and
Hermes prompt drift. `Production Readiness / config-audit` is failing as an external
configuration gate because the repository has no self-hosted target runners, no
configured target-runner label variable, no deployed launch-smoke URL, and no
controlled launch-smoke email template variable. The strict launch-smoke flags
are now configured as durable repository variables:
`AGENTDASH_LAUNCH_SMOKE_BILLING=true` and
`AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM=true`. The `npm-stable` environment is also
protected with required reviewer `thetangstr`, so stable publishing now has the
expected human approval gate. GitHub issue #350 tracks the remaining target
runner and deployed launch-smoke gates.

The local worktree is clean except for the existing untracked `.claire/`
directory, which belongs to a separate workspace and should not be deleted by
release cleanup or handoff automation.

The live `main` branch protection currently enforces admin protection, linear
history, force-push/deletion blocks, and required status checks:
`audit`, `drift`, `check`, `policy`, `e2e`, `verify`, and `config-audit`.
CODEOWNERS enforcement is not enabled yet because the valid CODEOWNERS owner
update in this PR must land on `main` first.

## Local Evidence Collected

The broad local verification set passed on baseline head `20d0a461`:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
./scripts/docker-build-test.sh
./scripts/release.sh stable --date 2026-05-22 --dry-run --skip-verify
```

The following focused readiness checks have passed on later local heads through
`03a55d32`:

```sh
pnpm exec vitest run server/src/__tests__/run-healer.test.ts
node --test scripts/ci/file-target-test-issue.test.mjs
node --check scripts/ci/run-target-test-profile.mjs
node --check scripts/ci/file-target-test-issue.mjs
node cli/dist/index.js --version
node cli/dist/index.js setup --help
ruby -e 'require "yaml"; ARGV.each { |f| YAML.load_file(f) }' .github/workflows/pr.yml .github/workflows/target-machine-test.yml .github/workflows/release.yml .github/workflows/release-smoke.yml .github/workflows/docker.yml
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.11 .github/workflows/pr.yml .github/workflows/target-machine-test.yml .github/workflows/release.yml .github/workflows/release-smoke.yml .github/workflows/docker.yml .github/workflows/refresh-lockfile.yml .github/workflows/agents-md-drift-check.yml .github/workflows/hermes-pr-audit.yml .github/workflows/hermes-prompt-drift.yml .github/workflows/upstream-digest.yml
ruby - <<'RUBY' > /tmp/upstream-digest-create-pr.sh
require 'yaml'
workflow = YAML.load_file('.github/workflows/upstream-digest.yml')
step = workflow.fetch('jobs').fetch('digest').fetch('steps').find { |s| s['name'] == 'Create or update pull request' }
puts step.fetch('run')
RUBY
bash -n /tmp/upstream-digest-create-pr.sh
rm -rf /tmp/agentdash-pr-canary-dry-run
git clone --shared --no-checkout /Users/Kailor/Documents/Projects/agentdash /tmp/agentdash-pr-canary-dry-run
cd /tmp/agentdash-pr-canary-dry-run
git checkout cc536979f5662109a42eec2e04cc2bf441c5373f
git checkout -B main HEAD
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile
git checkout -- pnpm-lock.yaml
./scripts/release.sh canary --skip-verify --dry-run
cd /Users/Kailor/Documents/Projects/agentdash
git push --dry-run origin HEAD:codex/invite-token-primitives
node scripts/ci/run-target-test-profile.mjs --profile core --requested-ref local-21694e7c --summary target-test/local-core-summary.json --logs-dir target-test/local-core-logs --artifact-name target-machine-test-core-local-21694e7c --paperclip-version latest
node --check scripts/ci/audit-production-readiness-config.mjs
node --test scripts/ci/audit-production-readiness-config.test.mjs
pnpm run test:production-readiness-config
node scripts/ci/audit-production-readiness-config.mjs --repo thetangstr/agentdash --output /tmp/agentdash-production-readiness-config.json
node scripts/ci/audit-production-readiness-config.mjs --repo thetangstr/agentdash --use-actions-vars-context
node --check scripts/ci/target-runner-preflight.mjs
node --test scripts/ci/target-runner-preflight.test.mjs
pnpm run test:target-runner-preflight
ruby -e 'require "yaml"; ARGV.each { |f| YAML.load_file(f) }' .github/workflows/production-readiness.yml
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.11 .github/workflows/production-readiness.yml .github/workflows/pr.yml
pnpm exec playwright test --config tests/launch-smoke/playwright.config.ts --list
pnpm run test:launch-smoke
git diff --check
pnpm install --frozen-lockfile
pnpm --filter agentdash typecheck
pnpm --filter agentdash build
pnpm -r typecheck
pnpm test:run
pnpm build
ruby -e 'require "yaml"; ARGV.each { |f| YAML.load_file(f) }' .github/workflows/*.yml
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.11 .github/workflows/*.yml
```

Observed narrow results from the latest continuation:

- `server/src/__tests__/run-healer.test.ts`: 5 tests passed.
- `scripts/ci/file-target-test-issue.test.mjs`: 5 tests passed.
- `node cli/dist/index.js --version`: `0.3.1`.
- `agentdash setup --help` exposes `adapter`, `server`, and `bootstrap`
  subcommands.
- The PR canary dry-run step checks out a temporary `main` branch before
  running `./scripts/release.sh canary --skip-verify --dry-run`, matching the
  release script's `main` guard.
- The upstream digest workflow parses under `actionlint`; its PR-body heredoc
  is indented as part of the YAML block and its extracted shell step passes
  `bash -n`.
- The isolated PR canary dry-run passed on disposable `main` at
  `cc536979f5662109a42eec2e04cc2bf441c5373f`; it resolved
  `2026.518.0-canary.2`, built workspace artifacts, built the CLI bundle, and
  previewed npm publish payloads for the public packages under the `canary`
  dist-tag.
- Dry-run push shows the PR branch can fast-forward cleanly.
- The local target-test core profile passed on
  `21694e7c29528e1a5a371a28e643b6301b4dfae6` with Node `v23.11.0` on Darwin
  arm64. The summary was generated at `2026-05-18T07:22:35.479Z`, with these
  commands exiting 0:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`
- `scripts/ci/audit-production-readiness-config.mjs` is a repeatable read-only
  GitHub configuration audit for the target-machine, release-environment, and
  deployed launch-smoke gates. Its unit tests pass. Against
  `thetangstr/agentdash`, it currently exits 1 because
  `AGENTDASH_TARGET_RUNNER_LABELS`, `AGENTDASH_LAUNCH_SMOKE_BASE_URL`, and
  `AGENTDASH_LAUNCH_SMOKE_EMAIL_TEMPLATE` are missing and there are no
  self-hosted runners. It confirms both release environments exist:
  `npm-canary` and `npm-stable`; `npm-stable` has required-reviewer protection.
- The audit helper now reads required repository variables through the GitHub
  Actions `vars` context and treats unreadable release environments or runner
  inventory as structured failed requirements while still writing the JSON
  artifact. If GitHub Actions' default `GITHUB_TOKEN` cannot read release
  environments or runner inventory, configure `PRODUCTION_READINESS_AUDIT_TOKEN`
  with the narrow read access described in `doc/RELEASE-AUTOMATION-SETUP.md`.
  The audit also writes a GitHub job summary with failed requirement IDs and the
  exact next `gh variable set ...` commands for the external operator.
- The audit now treats `AGENTDASH_LAUNCH_SMOKE_BILLING=true` and
  `AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM=true` as automated config requirements,
  so a future green production-readiness audit cannot skip Stripe Checkout
  session creation or real CoS/LLM reply coverage. Both variables are now set
  in the repository and pass the live config audit.
- The audit now requires `AGENTDASH_LAUNCH_SMOKE_EMAIL_TEMPLATE` to be an
  email-shaped template containing `{run}` and rejects the built-in fallback
  address. This keeps the durable production gate on a controlled unique test
  address instead of the launch-smoke default.
- The audit now treats missing `npm-stable` required-reviewer protection as a
  failed automated config requirement. The live repository has
  `npm-stable` protected by a `required_reviewers` rule for `@thetangstr`.
- Latest `Production Readiness / config-audit` job `76553741097` on
  `03a55d32` passes release environment, stable reviewer protection, branch
  protection, billing-required, and LLM-required gates. It fails only the
  external gates `target-runner-variable`, `target-runner-available`,
  `launch-smoke-url-variable`, and `launch-smoke-email-template-variable`.
- `.github/workflows/production-readiness.yml` now runs the audit on every PR,
  on `main` pushes, on a daily schedule, and on manual dispatch. The launch
  smoke job is still skipped on PRs. The audit uses repository `vars` for the
  target runner labels, deployed launch-smoke URL, and launch-smoke email
  template. It uses `PRODUCTION_READINESS_AUDIT_TOKEN` when present and
  `GITHUB_TOKEN` otherwise for GitHub API reads. It also checks the public
  branch summary for `main` branch protection and required always-running
  checks. If runner inventory, branch protection, or release environments cannot
  be read, the audit reports that as a structured failed requirement instead of
  crashing. `pr.yml` also runs the audit helper unit test in the normal verify
  job.
- `.github/workflows/target-machine-test.yml` now preflights configured
  self-hosted runner labels on `ubuntu-latest` before dispatching the target
  profile. If `AGENTDASH_TARGET_RUNNER_LABELS` is set before a matching runner
  is online, the workflow emits a normal failing target-test summary, artifact,
  PR comment, and issue-filing signal instead of sitting queued on unavailable
  labels.
- The live PR now has a passing `PR / target-test / resolve-target-runner`
  preflight check on head `03a55d32`. A live local preflight against
  `thetangstr/agentdash` correctly reports zero matching self-hosted runners and
  chooses the `ubuntu-latest` fail-fast path.
- `.github/CODEOWNERS` now uses the current repository collaborator
  `@thetangstr` for release infrastructure and package ownership. Add more
  maintainer/team owners before enabling branch protection's CODEOWNERS
  enforcement if a single-owner review gate is not acceptable.
- `doc/RELEASE-AUTOMATION-SETUP.md` now includes the operator runbook for the
  production-readiness audit gate: target-machine runner registration,
  `AGENTDASH_TARGET_RUNNER_LABELS`, optional
  `PRODUCTION_READINESS_AUDIT_TOKEN`, required branch checks, release
  infrastructure protection, and valid CODEOWNERS ownership.
- `tests/launch-smoke/` now contains a deployed-url launch smoke suite. It
  signs up a unique user, verifies `/cos` CoS welcome/composer, checks billing
  status, and can require Stripe Checkout session creation and a real LLM reply
  through env flags. `Production Readiness / launch-smoke` runs it on non-PR
  production-readiness workflow events once `AGENTDASH_LAUNCH_SMOKE_BASE_URL`
  and `AGENTDASH_LAUNCH_SMOKE_EMAIL_TEMPLATE` are configured. Manual
  `workflow_dispatch` runs can also provide
  `launch_smoke_base_url`, `launch_smoke_billing`, and
  `launch_smoke_expect_llm` as one-off overrides for deployed smoke validation;
  those overrides do not replace the durable repository variables required by
  the scheduled production gate.
- `pnpm exec playwright test --config tests/launch-smoke/playwright.config.ts
  --list` lists the deployed launch-smoke test. `pnpm run test:launch-smoke`
  exits 0 with the test skipped when no deployed base URL is configured, which
  keeps local/PR verification safe while the production-readiness workflow uses
  `AGENTDASH_LAUNCH_SMOKE_REQUIRED=true` to fail missing deployment config.
- `pnpm install --frozen-lockfile` passes with `pnpm-lock.yaml` kept out of the
  PR diff. The accidental direct CLI dependency additions on `postgres`, `ws`,
  and `zod` were removed because `cli/src` does not import them directly; the
  workspace packages that need those packages declare their own dependencies.
- `pnpm -r typecheck` passes on the broad local verification baseline, and the
  current PR verify job is green on `03a55d32`.
- `pnpm test:run` passes on the broad local verification baseline, and the
  current PR verify job is green on `03a55d32`.
- `pnpm build` passes on the broad local verification baseline, and the current
  PR verify and Docker jobs are green on `03a55d32`.
- Workflow YAML parsing and `actionlint` pass after moving GitHub Actions
  dependencies off Node 20 majors (`checkout` / `setup-node` to v6,
  `upload-artifact` to v7, `pnpm/action-setup` to v6).
- Docker PR validation now passes remotely on `03a55d32`. The previous PR
  Docker run reached the production image stage but timed out exporting the
  GitHub Actions cache. PR builds now validate a single `linux/amd64` image
  without cache export; non-PR builds still use multi-arch push/cache export.

## Fixed and Proven on PR Head

- #349: release workflow/docs now target `main`; stable dry-run passes locally.
- #348: release cadence has the weekly Friday stable train and canary-on-main
  path documented and wired locally.
- #347: launchd install now writes the wrapper it references, exports sourced
  env, generates missing auth secrets, and disables the known broken legacy
  plist case.
- #345: target-machine automation now records richer diagnostics and PR target
  test comments; the original mainline Vitest failure had no stack trace.
- #346: Hermes task-context delivery no longer depends on the downstream package
  patch. The server adapter registry maps `ctx.context.paperclipIssue`,
  `ctx.context.paperclipTaskMarkdown`, wake reason, and comment ID into the
  `ctx.config.task*` fields that `hermes-paperclip-adapter@0.3.0` actually
  reads.
- #297: run-healer eligibility scanner now has embedded Postgres integration
  coverage.
- #215: Docker image and npm release packaging have local smoke evidence. The
  actual published `agentdash@latest` and `ghcr.io/thetangstr/agentdash:latest`
  paths remain unproven until the release pipeline publishes this head.
- PR install gate: fixed by keeping `pnpm-lock.yaml` out of the diff and
  removing unnecessary direct CLI dependency specifiers so CI
  `pnpm install --frozen-lockfile` can succeed. This is now proven by the green
  PR verify job.
- GitHub Actions runtime warning: workflows now use Node 24-capable first-party
  action majors for checkout, setup-node, and artifact upload.
- PR Docker timeout: PR Docker builds now stay inside CI time limits and pass
  remotely at `03a55d32`.

## Remaining External Gates

These steps are required before calling the app production ready:

1. Push any handoff/workflow-readiness commits after this document refresh and
   confirm PR #344 points at `git rev-parse HEAD`.
2. Wait for PR #344 checks on the pushed head. Code/CI-readiness gates must be
   green: Agents MD Drift Check, Hermes PR Audit, Hermes Prompt Drift Check,
   PR policy, PR verify, PR e2e, target-test preflight, target-test,
   target-test-comment, and Docker workflow. At `03a55d32`, all of those checks
   are green. The
   production-readiness config audit may remain red only for the documented
   external repository configuration gaps below.
3. Register the self-hosted target runner and set repository variable
   `AGENTDASH_TARGET_RUNNER_LABELS` after the matching runner exists. The
   current repo has zero self-hosted runners, so the target workflow will fall
   back to GitHub-hosted Ubuntu runners until this is configured.
4. Deploy a staging or production launch target and set repository variables
   `AGENTDASH_LAUNCH_SMOKE_BASE_URL` to its HTTPS origin and
   `AGENTDASH_LAUNCH_SMOKE_EMAIL_TEMPLATE` to a controlled unique template such
   as `launch-smoke+{run}@your-domain.com`. The strict smoke flags are already
   set:
   - `AGENTDASH_LAUNCH_SMOKE_BILLING=true`
   - `AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM=true`
5. Re-run `Production Readiness / config-audit` and confirm only these four
   previously failing gates have turned green:
   - `target-runner-variable`
   - `target-runner-available`
   - `launch-smoke-url-variable`
   - `launch-smoke-email-template-variable`
6. Merge the PR to `main`.
7. Let the canary workflow publish from `main` and pass release smoke against
   `agentdash@canary`.
8. Confirm npm trusted publishing for every public package, then run the stable
   release workflow for `2026-05-22` with `dry_run=true`, then with
   `dry_run=false` after approval. The GitHub release environments
   `npm-canary` and `npm-stable` exist, and `npm-stable` has required reviewer
   protection. Absence of repository Actions secrets is expected for this
   workflow because npm publish uses GitHub Actions trusted publishing and
   Docker/GitHub release publishing uses `GITHUB_TOKEN`; the npm
   trusted-publishing configuration itself must still be confirmed in npm.
9. Confirm published package and image surfaces:
   - `npm view agentdash@latest version`
   - `npx agentdash@latest setup --help`
   - `docker run ghcr.io/thetangstr/agentdash:latest`
   - `gh workflow run release-smoke.yml -f paperclip_version=latest`
10. Deploy the cloud container with the production env vars from `doc/LAUNCH.md`:
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
11. Run the launch smoke from `doc/LAUNCH.md` against the deployed URL. The
    automated suite covers sign-up, CoS welcome/composer, billing status, and
    optional Stripe Checkout session creation/LLM reply. Stripe webhook and
    plan-tier transition still need an explicit Stripe test/live checkout run.
    For one-off GitHub validation before repository variables are finalized,
    run `Production Readiness` manually with `launch_smoke_base_url`.

Tracking issue: https://github.com/thetangstr/agentdash/issues/350

## Target Machine Agent Prompt

Use this after the branch is pushed:

```text
You are validating AgentDash production readiness on a target machine.

Repository: https://github.com/thetangstr/agentdash.git
Target ref: codex/invite-token-primitives
Expected commit: <paste current git rev-parse HEAD after pushing>

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
