# Release Automation Setup

This document covers the GitHub and npm setup required for the current AgentDash release model:

- automatic canaries from `main`
- manual stable promotion from a chosen source ref
- npm trusted publishing via GitHub OIDC
- protected release infrastructure in a public repository

Repo-side files that depend on this setup:

- `.github/workflows/release.yml`
- `.github/workflows/production-readiness.yml`
- `.github/workflows/target-machine-test.yml`
- `.github/CODEOWNERS`

Note:

- the release workflows intentionally use `pnpm install --no-frozen-lockfile`
- this matches the repo's current policy where `pnpm-lock.yaml` is refreshed by GitHub automation after manifest changes land on `main`
- the publish jobs then restore `pnpm-lock.yaml` before running `scripts/release.sh`, so the release script still sees a clean worktree

## 1. Merge the Repo Changes First

Before touching GitHub or npm settings, merge the release automation code so the referenced workflow filenames already exist on the default branch.

Required files:

- `.github/workflows/release.yml`
- `.github/workflows/production-readiness.yml`
- `.github/workflows/target-machine-test.yml`
- `.github/CODEOWNERS`

## 2. Configure npm Trusted Publishing

Do this for every public package that AgentDash publishes.

At minimum that includes:

- `agentdash`
- `@paperclipai/server`
- `@paperclipai/ui`
- public packages under `packages/`

### 2.1. In npm, open each package settings page

For each package:

1. open npm as an owner of the package
2. go to the package settings / publishing access area
3. add a trusted publisher for the GitHub repository `thetangstr/agentdash`

### 2.2. Add one trusted publisher entry per package

npm currently allows one trusted publisher configuration per package.

Configure:

- workflow: `.github/workflows/release.yml`

Repository:

- `thetangstr/agentdash`

Environment name:

- leave the npm trusted-publisher environment field blank

Why:

- the single `release.yml` workflow handles both canary and stable publishing
- GitHub environments `npm-canary` and `npm-stable` still enforce different approval rules on the GitHub side

### 2.3. Verify trusted publishing before removing old auth

After the workflows are live:

1. run a canary publish
2. confirm npm publish succeeds without any `NPM_TOKEN`
3. run a stable dry-run
4. run one real stable publish

Only after that should you remove old token-based access.

## 3. Remove Legacy npm Tokens

After trusted publishing works:

1. revoke any repository or organization `NPM_TOKEN` secrets used for publish
2. revoke any personal automation token that used to publish AgentDash
3. if npm offers a package-level setting to restrict publishing to trusted publishers, enable it

Goal:

- no long-lived npm publishing token should remain in GitHub Actions

## 4. Create GitHub Environments

Create two environments in the GitHub repository:

- `npm-canary`
- `npm-stable`

Path:

1. GitHub repository
2. `Settings`
3. `Environments`
4. `New environment`

## 5. Configure `npm-canary`

Recommended settings for `npm-canary`:

- environment name: `npm-canary`
- required reviewers: none
- wait timer: none
- deployment branches and tags:
  - selected branches only
  - allow `main`

Reasoning:

- every push to `main` should be able to publish a canary automatically
- no human approval should be required for canaries

## 6. Configure Production Readiness Audit Access

The `Production Readiness` workflow runs
`scripts/ci/audit-production-readiness-config.mjs` and intentionally fails until
the target-machine, deployed launch-smoke, and release-environment gates are
configured.

Run it locally at any time:

```sh
node scripts/ci/audit-production-readiness-config.mjs --repo thetangstr/agentdash
```

Success means:

- `AGENTDASH_TARGET_RUNNER_LABELS` is set to a non-GitHub-hosted runner label
  array
- at least one matching self-hosted runner is online and idle
- GitHub environments `npm-canary` and `npm-stable` exist
- `AGENTDASH_LAUNCH_SMOKE_BASE_URL` points at a deployed HTTPS launch target

Failure is expected before the target machine and deployed launch target exist.
Do not mark the app production ready while this audit fails, unless the release
owner has explicitly accepted GitHub-hosted target validation for that run.

### 6.1. Register a target-machine runner

In GitHub:

1. open `Settings` -> `Actions` -> `Runners`
2. choose `New self-hosted runner`
3. install it on the target machine that should validate real installs
4. add a stable custom label such as `agentdash-target`

Then set the repository variable:

```sh
gh variable set AGENTDASH_TARGET_RUNNER_LABELS \
  --repo thetangstr/agentdash \
  --body '["self-hosted","agentdash-target"]'
```

The target workflow will use those labels for scheduled runs and PR runs with
the `target-test` label. Without this variable, target-machine tests fall back
to `["ubuntu-latest"]`, which is useful parity coverage but not target-machine
launch evidence.

### 6.2. Optional audit token

The production-readiness workflow uses `GITHUB_TOKEN` by default. If that token
cannot read repository self-hosted runner inventory, create a repository secret
named `PRODUCTION_READINESS_AUDIT_TOKEN` containing a narrowly scoped token that
can read the repository's Actions runner inventory.

Only add this secret if the audit reports:

```text
Could not inspect self-hosted target runner inventory.
```

### 6.3. Configure deployed launch smoke

Set the repository variable used by the `Production Readiness / launch-smoke`
job:

```sh
gh variable set AGENTDASH_LAUNCH_SMOKE_BASE_URL \
  --repo thetangstr/agentdash \
  --body 'https://your-domain.com'
```

Optional repository variables:

```sh
gh variable set AGENTDASH_LAUNCH_SMOKE_EMAIL_TEMPLATE \
  --repo thetangstr/agentdash \
  --body 'launch-smoke+{run}@your-domain.com'

gh variable set AGENTDASH_LAUNCH_SMOKE_BILLING \
  --repo thetangstr/agentdash \
  --body 'true'

gh variable set AGENTDASH_LAUNCH_SMOKE_EXPECT_LLM \
  --repo thetangstr/agentdash \
  --body 'true'
```

If the deployment needs a fixed password policy, set
`AGENTDASH_LAUNCH_SMOKE_PASSWORD` as a repository secret. Otherwise the smoke
test generates a unique strong password per run.

The launch smoke intentionally refuses localhost and non-HTTPS URLs unless
`AGENTDASH_LAUNCH_SMOKE_ALLOW_LOCAL=true` is set for a local-only dry run.

## 7. Configure `npm-stable`

Recommended settings for `npm-stable`:

- environment name: `npm-stable`
- required reviewers: at least one maintainer other than the person triggering the workflow when possible
- prevent self-review: enabled
- admin bypass: disabled if your team can tolerate it
- wait timer: optional
- deployment branches and tags:
  - selected branches only
  - allow `main`

Reasoning:

- stable publishes should require an explicit human approval gate
- the workflow is manual, but the environment should still be the real control point

## 8. Protect `main`

Open the branch protection settings for `main`.

Recommended rules:

1. require pull requests before merging
2. require status checks to pass before merging
3. require review from code owners
4. dismiss stale approvals when new commits are pushed
5. restrict who can push directly to `main`

At minimum, make sure workflow and release script changes cannot land without review.

Add these required status checks once the workflows have run at least once on
the default branch:

- `Production Readiness / config-audit`
- `PR / policy`
- `PR / verify`
- `PR / e2e`
- `Docker / build-and-push`

If target-machine coverage is mandatory for every merge, also require:

- `PR / target-test`
- `PR / target-test-comment`

## 9. Enforce CODEOWNERS Review

This repo now includes `.github/CODEOWNERS`, but GitHub only enforces it if branch protection requires code owner reviews.

In branch protection for `main`, enable:

- `Require review from Code Owners`

Then verify the owner entries are correct for your actual maintainer set.

Current file:

- `.github/CODEOWNERS`

If `@cryppadotta` is not the right reviewer identity in the public repo, change it before enabling enforcement.

## 10. Protect Release Infrastructure Specifically

These files should always trigger code owner review:

- `.github/workflows/release.yml`
- `.github/workflows/production-readiness.yml`
- `.github/workflows/target-machine-test.yml`
- `scripts/release.sh`
- `scripts/release-lib.sh`
- `scripts/release-package-map.mjs`
- `scripts/ci/audit-production-readiness-config.mjs`
- `scripts/create-github-release.sh`
- `scripts/rollback-latest.sh`
- `doc/RELEASING.md`
- `doc/PUBLISHING.md`

If you want stronger controls, add a repository ruleset that explicitly blocks direct pushes to:

- `.github/workflows/**`
- `scripts/release*`

## 11. Do Not Store a Claude Token in GitHub Actions

Do not add a personal Claude or Anthropic token for automatic changelog generation.

Recommended policy:

- stable changelog generation happens locally from a trusted maintainer machine
- canaries never generate changelogs

This keeps LLM spending intentional and avoids a high-value token sitting in Actions.

## 12. Verify the Canary Workflow

After setup:

1. merge a harmless commit to `main`
2. open the `Release` workflow run triggered by that push
3. confirm it passes verification
4. confirm publish succeeds under the `npm-canary` environment
5. confirm the `release-smoke-canary-*` job passes against `agentdash@canary`
6. confirm npm now shows a new `canary` release
7. confirm a git tag named `canary/vYYYY.MDD.P-canary.N` was pushed

Install-path check:

```bash
npx agentdash@canary onboard
```

## 13. Verify the Stable Workflow

After at least one good canary exists:

1. resolve the target stable version with `./scripts/release.sh stable --date YYYY-MM-DD --print-version`
2. prepare `releases/vYYYY.MDD.P.md` on the source commit you want to promote
3. open `Actions` -> `Release`
4. run it with:
   - `source_ref`: the tested commit SHA or canary tag source commit
   - `stable_date`: leave blank or set the intended UTC date like `2026-03-18`
     do not enter a version like `2026.318.0`; the workflow computes that from the date
   - `dry_run`: `true`
5. confirm the dry-run succeeds
6. rerun with `dry_run: false`
7. approve the `npm-stable` environment when prompted
8. confirm npm `latest` points to the new stable version
9. confirm git tag `vYYYY.MDD.P` exists
10. confirm the `release-smoke-stable-*` job passes against `agentdash@latest`
11. confirm the GitHub Release was created after smoke passed

Implementation note:

- the GitHub Actions stable workflow calls `create-github-release.sh` with `PUBLISH_REMOTE=origin`
- local maintainer usage can still pass `PUBLISH_REMOTE=public-gh` explicitly when needed

## 14. Suggested Maintainer Policy

Use this policy going forward:

- canaries are automatic and cheap
- stables are manual and approved
- only stables get public notes and announcements
- release notes are committed before stable publish
- rollback uses `npm dist-tag`, not unpublish

## 15. Troubleshooting

### Trusted publishing fails with an auth error

Check:

1. the workflow filename on GitHub exactly matches the filename configured in npm
2. the package has the trusted publisher entry for the correct repository
3. the job has `id-token: write`
4. the job is running from the expected repository, not a fork

### Stable workflow runs but never asks for approval

Check:

1. the `publish` job uses environment `npm-stable`
2. the environment actually has required reviewers configured
3. the workflow is running in the canonical repository, not a fork

### CODEOWNERS does not trigger

Check:

1. `.github/CODEOWNERS` is on the default branch
2. branch protection on `main` requires code owner review
3. the owner identities in the file are valid reviewers with repository access

## Related Docs

- [doc/RELEASING.md](RELEASING.md)
- [doc/PUBLISHING.md](PUBLISHING.md)
- [doc/plans/2026-03-17-release-automation-and-versioning.md](plans/2026-03-17-release-automation-and-versioning.md)
