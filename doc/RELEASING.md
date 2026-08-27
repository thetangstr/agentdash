# Releasing AgentDash

Maintainer runbook for shipping the AgentDash application and owned packages through their separate release lines.

<!-- AgentDash: owned-release-boundary — DO NOT REMOVE OR REORDER THIS BLOCK -->
## AgentDash fork release boundary

AgentDash has two deliberately separate release lines:

- **Application/OTA:** `.github/workflows/release.yml` verifies an immutable application source, creates CalVer tags/releases, and builds checksummed updater assets. Every invocation passes `--skip-npm`; this path must never publish workspace packages.
- **Owned connector:** `.github/workflows/publish-connect.yml` publishes only `packages/connect` as `agentdash-connect`, preserving its `0.1.x` versions and `agentdash-connect-v*` tags. npm authenticates that workflow with trusted publishing/OIDC.

`scripts/release-package-map.mjs` is an explicit ownership allowlist. In this fork it contains only `packages/connect` / `agentdash-connect`; inherited `@paperclipai/*` and unprovisioned `@agentdash/*` names are not release targets. Add another package only after ownership, naming, trusted-publisher configuration, version policy, tests, and review are explicit.

Canonical AgentDash commands:

```bash
./scripts/release.sh canary --skip-npm --dry-run
./scripts/release.sh stable --skip-npm --dry-run
```

Publish `agentdash-connect` by merging its reviewed version bump and notes, running the `Publish agentdash-connect` workflow dry-run, then pushing the matching `agentdash-connect-vX.Y.Z` tag through the normal GitHub path. Do not use `scripts/release.sh` to assign a CalVer version to the connector.
<!-- /AgentDash: owned-release-boundary -->

The release model is now commit-driven:

1. Every push to `main` verifies and tags an application canary automatically.
2. Stable releases are manually promoted from a chosen tested commit or canary tag.
3. Stable release notes live in `releases/vYYYY.MDD.P.md` on the release-control ref.
4. Only stable releases get GitHub Releases.

## Versioning Model

Paperclip uses calendar versions that still fit semver syntax:

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

Every stable application release has four separate surfaces:

1. **Verification** — the exact git SHA passes typecheck, tests, and build
2. **Provenance** — the updater controller, checksum, and manifest bind the application source and release-control SHAs
3. **GitHub** — the stable release gets a git tag, GitHub Release, and updater assets
4. **Staging / customer handoff** — an isolated upgrade and rollback rehearsal is recorded before a customer installation is authorized

A stable release is done only when all four surfaces are handled.

Canaries cover verification plus an internal traceability tag. They never publish npm packages.

## Core Invariants

- canaries run from `main`
- stables publish from an explicitly chosen source ref
- tags point at the original source commit, not a generated release commit
- stable notes are always `releases/vYYYY.MDD.P.md`
- stable promotion keeps the chosen source ref in a separate clean checkout, so release-control changes and notes cannot change the tag target
- stable source-install controls are uploaded as checksummed GitHub Release assets with source and release-control provenance
- canaries never create GitHub Releases
- canaries never require changelog generation

## TL;DR

### Canary

Every push to `master` runs the canary path inside [`.github/workflows/release.yml`](../.github/workflows/release.yml).

It:

- verifies the pushed commit
- computes the canary version for the current UTC date
- passes `--skip-npm`, so no inherited or unprovisioned package can be published
- creates a git tag `canary/vYYYY.MDD.P-canary.N`

### Stable

Use [`.github/workflows/release.yml`](../.github/workflows/release.yml) from the Actions tab with the manual `workflow_dispatch` inputs.

[Run the action here](https://github.com/thetangstr/agentdash/actions/workflows/release.yml)

Inputs:

- `source_ref`
  - full 40-character commit SHA; branches and movable tags are rejected
- `stable_date`
  - optional UTC date override in `YYYY-MM-DD`
  - enter a date like `2026-03-18`, not a version like `2026.318.0`
- `dry_run`
  - preview only when true

Before running stable:

1. pick the canary commit or tag you trust
2. resolve the target stable version with `./scripts/release.sh stable --skip-npm --date "$(date +%F)" --print-version`
3. create or update `releases/vYYYY.MDD.P.md` on the default branch that contains the release workflow
4. run the stable workflow from that default branch with the chosen immutable commit as `source_ref`

Example:

- `source_ref`: `0123456789abcdef0123456789abcdef01234567`
- `stable_date`: `2026-03-18`
- resulting stable version: `2026.318.0`

The workflow uses two explicit checkouts:

- **release control** — the default-branch workflow, release scripts, and stable notes
- **immutable source** — the exact `source_ref` that is verified, packaged, and tagged

It then:

- re-verifies the exact source ref
- computes the next stable patch slot for the chosen UTC date
- does not publish npm packages
- creates git tag `vYYYY.MDD.P` on the immutable source commit, not the release-control commit
- builds the standalone Mac mini source-launchd controller from the release-control checkout, with a SHA-256 checksum and JSON provenance manifest
- creates or updates the GitHub Release from `releases/vYYYY.MDD.P.md` and uploads those release-control assets

## Local Commands

### Preview a canary locally

```bash
./scripts/release.sh canary --skip-npm --dry-run
```

### Preview a stable locally

```bash
./scripts/release.sh stable --skip-npm --dry-run
```

Live stable publication is only through `.github/workflows/release.yml`. Do not
manually publish or tag around that workflow.

## Stable Changelog Workflow

Stable changelog files live at:

- `releases/vYYYY.MDD.P.md`

Canaries do not get changelog files.

Recommended local generation flow:

```bash
VERSION="$(./scripts/release.sh stable --skip-npm --date 2026-03-18 --print-version)"
claude --print --output-format stream-json --verbose --dangerously-skip-permissions --model claude-opus-4-6 "Use the release-changelog skill to draft or update releases/v${VERSION}.md for Paperclip. Read doc/RELEASING.md and .agents/skills/release-changelog/SKILL.md, then generate the stable changelog for v${VERSION} from commits since the last stable tag. Do not create a canary changelog."
```

The repo intentionally does not run this through GitHub Actions because:

- canaries are too frequent
- stable notes are the only public narrative surface that needs LLM help
- maintainer LLM tokens should not live in Actions

## Smoke Testing

Download the application release controller, checksum, and manifest from the
GitHub Release. Verify the checksum and both provenance SHAs, then exercise the
controller in a loopback-only synthetic instance before customer installation.

Minimum checks:

- the checksummed release controller installs or upgrades the synthetic instance
- onboarding completes without crashes
- authenticated login works with the smoke credentials
- the browser lands in onboarding on a fresh instance
- company creation succeeds
- the first CEO agent is created
- the first CEO heartbeat run is triggered

## Rollback

Application rollback uses the generated `agentdash-source-rollback.sh` wrapper,
which returns to the previously recorded immutable commit. Verify restored
health and data before ending the rehearsal. npm versions of `agentdash-connect`
are immutable; correct connector defects with a new patch release.

## Failure Playbooks

### If the canary publishes but smoke testing fails

Do not run stable.

Instead:

1. fix the issue on `master`
2. merge the fix
3. wait for the next automatic canary
4. rerun smoke testing

### If the application tag exists but the GitHub Release or assets fail

Stop customer installation. Repair and rerun the canonical workflow against the
same immutable source and release-control commits; never retag a different
commit with the same version.

## Related Files

- [`scripts/release.sh`](../scripts/release.sh)
- [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh)
- [`doc/PUBLISHING.md`](PUBLISHING.md)
- [`doc/RELEASE-AUTOMATION-SETUP.md`](RELEASE-AUTOMATION-SETUP.md)
