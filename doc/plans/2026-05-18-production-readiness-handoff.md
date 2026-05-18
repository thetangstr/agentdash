# Production Readiness Handoff

Date: 2026-05-18

## Current State

Active branch: `codex/invite-token-primitives`

Local evidence baseline:

```text
20d0a4611761f512b4acde6dfd8ef95cd31c6b5f Make the Docker image a runnable distribution
```

Remote PR head:

```text
3858878d27cad5aa52a7d1ec5ec38b7833ee5035 Make target-test PR comments use issue comments
```

The current branch head may be newer than this baseline as readiness fixes are
added. Run `git rev-parse HEAD` before handing off to a remote runner or target
machine.

The local branch is ahead of `origin/codex/invite-token-primitives`.
GitHub PR checks are green for the older remote head only. The current local
production-readiness commits still need to be pushed before GitHub CI, target
machine tests, canary release, stable release, or production deployment can
prove this head.

The local worktree is clean except for the existing untracked `.claire/`
directory, which belongs to a separate workspace and should not be deleted by
release cleanup or handoff automation.

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
`21694e7c`:

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
node scripts/ci/audit-production-readiness-config.mjs --repo thetangstr/agentdash --output /tmp/agentdash-production-readiness-config.json
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
  GitHub configuration audit for the target-machine and release-environment
  gates. Its unit tests pass. Against `thetangstr/agentdash`, it currently
  exits 1 because `AGENTDASH_TARGET_RUNNER_LABELS` is missing and there are no
  self-hosted runners. It confirms both release environments exist:
  `npm-canary` and `npm-stable`.

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

1. Push `codex/invite-token-primitives` so PR #344 points at the current local
   `git rev-parse HEAD`.
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
3. Register the self-hosted target runner and set repository variable
   `AGENTDASH_TARGET_RUNNER_LABELS` if real target-machine coverage is required.
   The current repo has zero self-hosted runners and no repository variables
   visible through `gh`, so the target workflow will fall back to GitHub-hosted
   Ubuntu runners until this is configured.
4. Merge the PR to `main`.
5. Let the canary workflow publish from `main` and pass release smoke against
   `agentdash@canary`.
6. Confirm npm trusted publishing for every public package, then run the stable
   release workflow for `2026-05-22` with `dry_run=true`, then with
   `dry_run=false` after approval. The GitHub release environments
   `npm-canary` and `npm-stable` exist. Absence of repository Actions secrets is
   expected for this workflow because npm publish uses GitHub Actions trusted
   publishing and Docker/GitHub release publishing uses `GITHUB_TOKEN`; the npm
   trusted-publishing configuration itself must still be confirmed in npm.
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
