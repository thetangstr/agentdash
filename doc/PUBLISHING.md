# Publishing AgentDash-owned npm Packages

Low-level reference for npm publication from the AgentDash fork.

<!-- AgentDash: owned-release-boundary — DO NOT REMOVE OR REORDER THIS BLOCK -->
## AgentDash-owned npm publication

The fork publishes only packages in the explicit allowlist at
`scripts/release-package-map.mjs`. The current allowlist contains one package:

- `packages/connect` -> `agentdash-connect`

Its canonical publisher is `.github/workflows/publish-connect.yml`, with semver
`0.1.x`, tags `agentdash-connect-vX.Y.Z`, and npm trusted publishing/OIDC. The
application CalVer workflow always passes `--skip-npm` and cannot publish
inherited `@paperclipai/*` packages or unprovisioned `@agentdash/*` names. Never
add a long-lived npm token as a fallback.
<!-- /AgentDash: owned-release-boundary -->

For the application/OTA workflow, use [doc/RELEASING.md](RELEASING.md). It is a
separate release line and never publishes npm packages.

## Owned Package Selection

`scripts/release-package-map.mjs` is the only package-ownership map. It validates
the exact package directory, name, public status, and current version. Selection
fails closed if an allowlisted package is missing, renamed, or private.

Do not replace the allowlist with workspace discovery. The monorepo contains
inherited and internal package names that AgentDash does not own or intend to
publish.

Adding another package requires all of the following in one reviewed change:

1. proven registry ownership;
2. an explicit version and tag lineage;
3. a package-specific trusted-publisher workflow;
4. package-content and release-selection regressions;
5. release notes and provenance assets;
6. no token-based credential fallback.

## `agentdash-connect` Version and Tag Lineage

- npm package: `agentdash-connect`
- source: `packages/connect`
- version: semver
- tag: `agentdash-connect-vX.Y.Z`
- notes: `packages/connect/releases/vX.Y.Z.md`
- workflow: `.github/workflows/publish-connect.yml`

The workflow verifies that the tag, package manifest, and release-note heading
agree before any publish step. npm versions are immutable; if a version already
exists, the workflow fails and requires a new patch version.

## Canonical Dry-run and Publish

After the reviewed version bump and notes merge to `main`:

1. run `Publish agentdash-connect` with `dry_run: true`;
2. require tests, owned-package validation, notes validation, and `npm publish
   --dry-run` to pass;
3. push the matching `agentdash-connect-vX.Y.Z` tag through the normal GitHub
   path;
4. let the tag-triggered workflow publish with OIDC and create the GitHub
   Release.

Do not run an ad hoc local `npm publish`, do not tag a commit that has not passed
the normal PR gates, and do not configure `NODE_AUTH_TOKEN` or `NPM_TOKEN` as a
fallback.

## Published Evidence

The live workflow records and verifies:

- the packed tarball and exact package contents;
- SHA-256 checksum;
- npm `dist.integrity`;
- npm `gitHead` equal to the tagged release-control commit;
- application/OTA source provenance where the connector release references an
  application release;
- the package-specific GitHub tag, notes, release, and attached JSON manifest.

Registry integrity or git-head drift is a hard failure. Do not accept a package
that cannot be reconciled to the reviewed tarball and tag.

## Rollback and Remediation

npm versions are immutable and are not unpublished as an ordinary rollback. If
the connector release is defective, stop recommending that version and publish
a reviewed patch release. Application rollback is separate and uses the
generated source rollback wrapper described in [doc/RELEASING.md](RELEASING.md).

## Related Files

- [`.github/workflows/publish-connect.yml`](../.github/workflows/publish-connect.yml)
- [`packages/connect/package.json`](../packages/connect/package.json)
- [`packages/connect/releases/`](../packages/connect/releases/)
- [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)
- [`scripts/build-release-control-assets.mjs`](../scripts/build-release-control-assets.mjs)
- [`doc/RELEASE-AUTOMATION-SETUP.md`](RELEASE-AUTOMATION-SETUP.md)
