# Releasing AgentDash

Maintainer runbook for shipping AgentDash across npm, GitHub, and the website-facing changelog surface.

The release model is now commit-driven:

1. Every push to `agentdash-main` publishes a canary automatically.
2. Stable releases are manually promoted from a chosen tested commit or canary tag.
3. Stable release notes live in `releases/vYYYY.MDD.P.md`.
4. Only stable releases get GitHub Releases.

## Versioning Model

AgentDash uses calendar versions that still fit semver syntax:

- stable: `YYYY.MDD.P`
- canary: `YYYY.MDD.P-canary.N`

Examples:

- first stable on March 18, 2026: `2026.318.0`
- second stable on March 18, 2026: `2026.318.1`
- fourth canary for the `2026.318.1` line: `2026.318.1-canary.3`

Important constraints:

- the middle numeric slot is `MDD`, where `M` is the UTC month and `DD` is the zero-padded UTC day
- use `2026.303.0` for March 3, not `2026.33.0`
- do not use leading zeroes such as `2026.0318.0`
- do not use four numeric segments such as `2026.3.18.1`
- the semver-safe canary form is `2026.318.0-canary.1`

## Release Surfaces

Every stable release has four separate surfaces:

1. **Verification** — the exact git SHA passes typecheck, tests, and build
2. **npm** — `agentdash` and public workspace packages are published
3. **GitHub** — the stable release gets a git tag and GitHub Release
4. **Website / announcements** — the stable changelog is published externally and announced

A stable release is done only when all four surfaces are handled.

Canaries only cover the first two surfaces plus an internal traceability tag.

Container publishing and remote-machine deployment are adjacent but separate:

- [`.github/workflows/docker.yml`](../.github/workflows/docker.yml) publishes GHCR images from `agentdash-main` and stable tags.
- [`.github/workflows/deploy-remote.yml`](../.github/workflows/deploy-remote.yml) is the manual deploy path for a Docker-capable remote machine.

## Core Invariants

- canaries publish from `agentdash-main`
- stables publish from an explicitly chosen source ref
- tags point at the original source commit, not a generated release commit
- stable notes are always `releases/vYYYY.MDD.P.md`
- canaries never create GitHub Releases
- canaries never require changelog generation

## TL;DR

### Canary

Every push to `agentdash-main` runs the canary path inside [`.github/workflows/release.yml`](../.github/workflows/release.yml).

It:

- verifies the pushed commit
- computes the canary version for the current UTC date
- publishes under npm dist-tag `canary` with `npm publish --provenance`
- creates a git tag `canary/vYYYY.MDD.P-canary.N`

Users install canaries with:

```bash
npx agentdash@canary onboard
# or
npx agentdash@canary onboard --data-dir "$(mktemp -d /tmp/agentdash-canary.XXXXXX)"
```

### Stable

Use [`.github/workflows/release.yml`](../.github/workflows/release.yml) from the Actions tab with the manual `workflow_dispatch` inputs.

[Run the action here](https://github.com/thetangstr/agentdash/actions/workflows/release.yml)

Inputs:

- `source_ref`
  - commit SHA, branch, or tag
- `stable_date`
  - optional UTC date override in `YYYY-MM-DD`
  - enter a date like `2026-03-18`, not a version like `2026.318.0`
- `dry_run`
  - preview only when true

Before running stable:

1. pick the canary commit or tag you trust
2. resolve the target stable version with `./scripts/release.sh stable --date "$(date +%F)" --print-version`
3. create or update `releases/vYYYY.MDD.P.md` on that source ref
4. run the stable workflow from that source ref

Example:

- `source_ref`: `agentdash-main`
- `stable_date`: `2026-03-18`
- resulting stable version: `2026.318.0`

The workflow:

- re-verifies the exact source ref
- computes the next stable patch slot for the chosen UTC date
- publishes `YYYY.MDD.P` under npm dist-tag `latest` with `npm publish --provenance`
- creates git tag `vYYYY.MDD.P`
- creates or updates the GitHub Release from `releases/vYYYY.MDD.P.md`

## Local Commands

### Preview a canary locally

```bash
./scripts/release.sh canary --dry-run
```

### Preview a stable locally

```bash
./scripts/release.sh stable --dry-run
```

### Publish a stable locally

This is mainly for emergency/manual use. The normal path is the GitHub workflow.

```bash
./scripts/release.sh stable
git push public-gh refs/tags/vYYYY.MDD.P
PUBLISH_REMOTE=public-gh ./scripts/create-github-release.sh YYYY.MDD.P
```

## Stable Changelog Workflow

Stable changelog files live at:

- `releases/vYYYY.MDD.P.md`

Canaries do not get changelog files.

Recommended local generation flow:

```bash
VERSION="$(./scripts/release.sh stable --date 2026-03-18 --print-version)"
claude --print --output-format stream-json --verbose --dangerously-skip-permissions --model claude-opus-4-6 "Use the release-changelog skill to draft or update releases/v${VERSION}.md for AgentDash. Read doc/RELEASING.md and .agents/skills/release-changelog/SKILL.md, then generate the stable changelog for v${VERSION} from commits since the last stable tag. Do not create a canary changelog."
```

## GitHub Release Contract

Stable GitHub Releases are now formalized with these rules:

1. the git tag is always `vYYYY.MDD.P`
2. the GitHub Release title is always `AgentDash vYYYY.MDD.P`
3. the GitHub Release body always comes from `releases/vYYYY.MDD.P.md`
4. the release notes file must exist before the stable publish begins
5. the release notes should follow [`releases/TEMPLATE.md`](../releases/TEMPLATE.md)

This keeps the GitHub release surface deterministic and machine-repeatable.

The publish jobs rely on npm trusted publishing from GitHub Actions. In practice that means:

- `actions/setup-node` must set `registry-url: https://registry.npmjs.org`
- the publish job must keep `id-token: write`
- the release script must publish through the npm CLI, not `pnpm publish`

The repo intentionally does not run this through GitHub Actions because:

- canaries are too frequent
- stable notes are the only public narrative surface that needs LLM help
- maintainer LLM tokens should not live in Actions

## Smoke Testing

For a canary:

```bash
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
```

For the current stable:

```bash
PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

Useful isolated variants:

```bash
HOST_PORT=3232 DATA_DIR=./data/release-smoke-canary PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
HOST_PORT=3233 DATA_DIR=./data/release-smoke-stable PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

Automated browser smoke is also available:

```bash
gh workflow run release-smoke.yml -f paperclip_version=canary
gh workflow run release-smoke.yml -f paperclip_version=latest
```

Minimum checks:

- `npx agentdash@canary onboard` installs
- onboarding completes without crashes
- authenticated login works with the smoke credentials
- the browser lands in onboarding on a fresh instance
- company creation succeeds
- the first CEO agent is created
- the first CEO heartbeat run is triggered

## Rollback

Rollback does not unpublish versions.

It only moves the `latest` dist-tag back to a previous stable:

```bash
./scripts/rollback-latest.sh 2026.318.0 --dry-run
./scripts/rollback-latest.sh 2026.318.0
```

Then fix forward with a new stable patch slot or release date.

## Failure Playbooks

### If the canary publishes but smoke testing fails

Do not run stable.

Instead:

1. fix the issue on `agentdash-main`
2. merge the fix
3. wait for the next automatic canary
4. rerun smoke testing

### If stable npm publish succeeds but tag push or GitHub release creation fails

This is a partial release. npm is already live.

Do this immediately:

1. push the missing tag
2. rerun `PUBLISH_REMOTE=public-gh ./scripts/create-github-release.sh YYYY.MDD.P`
3. verify the GitHub Release notes point at `releases/vYYYY.MDD.P.md`

Do not republish the same version.

### If `latest` is broken after stable publish

Roll back the dist-tag:

```bash
./scripts/rollback-latest.sh YYYY.MDD.P
```

Then fix forward with a new stable release.

## Related Files

- [`scripts/release.sh`](../scripts/release.sh)
- [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh)
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh)
- [`doc/PUBLISHING.md`](PUBLISHING.md)
- [`doc/RELEASE-AUTOMATION-SETUP.md`](RELEASE-AUTOMATION-SETUP.md)
- [`releases/TEMPLATE.md`](../releases/TEMPLATE.md)
