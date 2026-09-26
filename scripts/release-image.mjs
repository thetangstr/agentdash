#!/usr/bin/env node
// AgentDash (#732): the one place that decides what a stable release's
// container image is called and how its digest is written into the GitHub
// Release body. release.yml, create-github-release.sh and
// scripts/hosted/provision-box.sh all agree through this file.
//
//   node scripts/release-image.mjs tags <version> [--repo <ref>]
//       one image reference per line, for `docker buildx imagetools create -t`
//   node scripts/release-image.mjs section <version> <digest> [--repo <ref>]
//       the Markdown appended to the GitHub Release notes
//
// Tags: `v<version>` is canonical (it is the git tag, and what hosted boxes
// deploy); `<version>` is kept because docker.yml's semver pattern and older
// runbook copies use the no-v form. `latest` is never moved here: docker.yml
// owns `latest` as the tip of main.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_IMAGE_REPO = "ghcr.io/thetangstr/agentdash";
export const STABLE_IMAGE_PLATFORMS = ["linux/amd64", "linux/arm64"];

const VERSION_RE = /^[0-9]{4}\.[0-9]{3,4}\.[0-9]+$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const REPO_RE = /^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)+$/;

export function assertStableVersion(version) {
  if (!VERSION_RE.test(String(version ?? ""))) {
    throw new Error(`stable version must look like 2026.925.0 (no leading v), got: ${version}`);
  }
  return version;
}

export function assertDigest(digest) {
  if (!DIGEST_RE.test(String(digest ?? ""))) {
    throw new Error(`image digest must be sha256:<64 lowercase hex>, got: ${digest}`);
  }
  return digest;
}

export function assertRepo(repo) {
  if (!REPO_RE.test(String(repo ?? ""))) {
    throw new Error(`image repository must be a lowercase registry path without a tag, got: ${repo}`);
  }
  return repo;
}

export function stableImageTags(version, repo = DEFAULT_IMAGE_REPO) {
  assertStableVersion(version);
  assertRepo(repo);
  return [`${repo}:v${version}`, `${repo}:${version}`];
}

export function imageReleaseSection(version, digest, repo = DEFAULT_IMAGE_REPO) {
  const [canonical, noV] = stableImageTags(version, repo);
  assertDigest(digest);
  return [
    "## Container image",
    "",
    `Built from this release's tagged commit for ${STABLE_IMAGE_PLATFORMS.join(" and ")}.`,
    "",
    "| | |",
    "|---|---|",
    `| Tag | \`${canonical}\` (also \`${noV}\`) |`,
    `| Digest | \`${digest}\` |`,
    "",
    "Deploy by digest, which cannot move:",
    "",
    "```sh",
    `docker pull ${repo}@${digest}`,
    "```",
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const positional = [];
  let repo = DEFAULT_IMAGE_REPO;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo") {
      repo = argv[i + 1];
      i += 1;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, repo };
}

function main(argv) {
  const [command, ...rest] = argv;
  const { positional, repo } = parseArgs(rest);
  if (command === "tags" && positional.length === 1) {
    process.stdout.write(`${stableImageTags(positional[0], repo).join("\n")}\n`);
    return;
  }
  if (command === "section" && positional.length === 2) {
    process.stdout.write(imageReleaseSection(positional[0], positional[1], repo));
    return;
  }
  throw new Error(
    "usage: release-image.mjs tags <version> [--repo <ref>] | section <version> <digest> [--repo <ref>]",
  );
}

// Compare realpaths: argv[1] keeps a symlinked path as typed.
const invokedDirectly = (() => {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  }
}
