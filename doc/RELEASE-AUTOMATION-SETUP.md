# AgentDash Release Automation Setup

This document covers the GitHub and npm configuration for AgentDash's two
separate release lines:

- application/OTA CalVer tags and GitHub Releases;
- owned `agentdash-connect` semver publication through npm trusted publishing.

<!-- AgentDash: owned-release-boundary — DO NOT REMOVE OR REORDER THIS BLOCK -->
## AgentDash fork configuration

For `thetangstr/agentdash`, npm trusted publishing is configured only for
packages the fork owns and intends to publish. The current package is
`agentdash-connect`:

- npm package: `agentdash-connect`
- repository: `thetangstr/agentdash`
- workflow filename: `publish-connect.yml`
- environment: blank
- GitHub permission: `id-token: write`
- long-lived npm token: forbidden

`.github/workflows/release.yml` is the application/OTA CalVer workflow and
passes `--skip-npm`; it must not be configured as the trusted publisher for
inherited or unprovisioned workspace names. A package is added to
`scripts/release-package-map.mjs` only after npm ownership and its
package-specific trusted-publishing/version contract are proven.
<!-- /AgentDash: owned-release-boundary -->

## 1. Merge Release Controls First

The referenced workflows and scripts must exist on `main` before registry or
GitHub settings point to them. Changes to these files use a pull request, normal
checks, and code-owner review:

- `.github/workflows/release.yml`
- `.github/workflows/publish-connect.yml`
- `scripts/release.sh`
- `scripts/release-lib.sh`
- `scripts/release-package-map.mjs`
- `scripts/build-release-control-assets.mjs`
- `scripts/create-github-release.sh`

## 2. Configure `agentdash-connect` Trusted Publishing

On the npm package settings page for `agentdash-connect`, configure one GitHub
Actions trusted publisher:

- organization or user: `thetangstr`
- repository: `agentdash`
- workflow filename: `publish-connect.yml`
- environment: blank

The workflow job must retain `id-token: write` and must not set `NODE_AUTH_TOKEN`
or `NPM_TOKEN`. Trusted publishing is verified by a real tag-triggered publish;
a local `npm whoami` is not a substitute.

Historical successful OIDC publishes support the configuration, but each new
release must still reconcile the registry integrity and `gitHead` to its own
reviewed tarball and tag.

## 3. Remove Legacy npm Credentials

No long-lived npm publishing credential should exist in GitHub Actions or on a
customer machine. Revoke any old repository, organization, or personal
automation token after the trusted publisher is proven. Never copy a credential
from another machine to repair a release.

## 4. Protect the GitHub Release Paths

Protect `main` with:

1. pull requests required before merge;
2. required status checks;
3. code-owner review for workflows and release scripts;
4. stale approval dismissal after new commits;
5. restricted direct pushes.

Use a protected environment for live application stable publication if the
repository's existing `npm-stable` environment is already the approval gate.
The historical name does not authorize npm publication: `release.yml` must
still pass `--skip-npm` in every path.

## 5. Verify the Application Canary

After a merge to `main`:

1. open the push-triggered `Release` workflow;
2. require verification to pass;
3. confirm no npm publish step ran;
4. confirm a `canary/vYYYY.MDD.P-canary.N` tag points to the merged commit.

Canaries do not create GitHub Releases and are not installed through an
inherited npm package.

## 6. Verify the Application Stable Workflow

1. resolve the version with `./scripts/release.sh stable --skip-npm --date
   YYYY-MM-DD --print-version`;
2. prepare `releases/vYYYY.MDD.P.md` on `main`;
3. dispatch `Release` with an immutable 40-character `source_ref`, the intended
   UTC `stable_date`, and `dry_run: true`;
4. require source verification, all hard gates, the dry-run, and the release
   asset preview to pass;
5. rerun with `dry_run: false` only after the preview is accepted;
6. verify the tag points to the immutable source, while the asset manifest
   records both source and release-control SHAs;
7. verify the GitHub Release, controller, checksum, and JSON manifest.

No application workflow step publishes npm packages.

## 7. Verify `agentdash-connect`

After the reviewed semver bump and package notes merge:

1. dispatch `Publish agentdash-connect` with `dry_run: true`;
2. require connector tests, ownership selection, tag/version rules, notes, and
   package-content inspection to pass;
3. confirm the target version is absent from npm;
4. push the matching `agentdash-connect-vX.Y.Z` tag;
5. require the tag-triggered OIDC publish to pass;
6. verify npm version, provenance, `dist.integrity`, `gitHead`, tarball contents,
   GitHub tag/release, checksum, and JSON manifest.

An authentication error at publish time means the trusted-publisher setup is
missing or mismatched. Stop; do not add a token workaround.

## 8. Troubleshooting

### Trusted publishing fails

Check the exact package, owner, repository, workflow filename, blank environment
field, `id-token: write`, and that the job runs in the canonical repository. If
any identity is ambiguous, do not publish.

### Stable application workflow does not request approval

Check that the live job references the intended protected GitHub environment
and that its reviewer rules are enabled. Do not weaken the workflow to bypass a
missing approval.

### CODEOWNERS does not trigger

Check `.github/CODEOWNERS`, branch protection on `main`, and that listed owners
have repository access.

## Related Docs

- [doc/RELEASING.md](RELEASING.md)
- [doc/PUBLISHING.md](PUBLISHING.md)
