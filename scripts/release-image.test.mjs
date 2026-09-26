// AgentDash (#732): tag and digest logic for the stable GHCR image.
//
// release.yml cannot push an image from a pull request, so the naming and the
// release-body rendering it relies on are pinned here instead. The real push
// is verified on the next stable cut (see the PR for the checklist).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_IMAGE_REPO,
  STABLE_IMAGE_PLATFORMS,
  imageReleaseSection,
  stableImageTags,
} from "./release-image.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-image.mjs");
const DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;

test("stable tags are the v-prefixed git tag first, then the no-v form, never latest", () => {
  assert.deepEqual(stableImageTags("2026.925.0"), [
    "ghcr.io/thetangstr/agentdash:v2026.925.0",
    "ghcr.io/thetangstr/agentdash:2026.925.0",
  ]);
  assert.equal(DEFAULT_IMAGE_REPO, "ghcr.io/thetangstr/agentdash");
  assert.ok(!stableImageTags("2026.1231.4").some((tag) => tag.endsWith(":latest")));
});

test("the default tag matches what provision-box.sh deploys for a release", () => {
  // provision-box.sh: IMAGE="ghcr.io/thetangstr/agentdash:${RELEASE}"
  const release = "v2026.924.0";
  const image = execFileSync("bash", ["-c", 'RELEASE="$1"; echo "ghcr.io/thetangstr/agentdash:${RELEASE}"', "bash", release], {
    encoding: "utf8",
  }).trim();
  assert.equal(stableImageTags(release.slice(1))[0], image);
});

test("rejects versions that are not a stable CalVer without a v", () => {
  for (const bad of ["v2026.925.0", "2026.925.0-canary.1", "2026.925", "", undefined]) {
    assert.throws(() => stableImageTags(bad), /stable version/);
  }
});

test("rejects a repository with a tag or uppercase letters", () => {
  assert.throws(() => stableImageTags("2026.925.0", "ghcr.io/thetangstr/agentdash:latest"), /repository/);
  assert.throws(() => stableImageTags("2026.925.0", "ghcr.io/TheTangstr/agentdash"), /repository/);
});

test("the release section records tag, digest, and a digest-pinned pull", () => {
  const section = imageReleaseSection("2026.925.0", DIGEST);
  assert.match(section, /^## Container image$/m);
  assert.match(section, /`ghcr\.io\/thetangstr\/agentdash:v2026\.925\.0`/);
  assert.match(section, /`ghcr\.io\/thetangstr\/agentdash:2026\.925\.0`/);
  assert.match(section, new RegExp(`\\| Digest \\| \`${DIGEST}\` \\|`));
  assert.match(section, new RegExp(`docker pull ghcr\\.io/thetangstr/agentdash@${DIGEST}`));
  for (const platform of STABLE_IMAGE_PLATFORMS) assert.match(section, new RegExp(platform));
});

test("rejects a digest that is not sha256 hex", () => {
  for (const bad of ["", "sha256:abc", `sha512:${"a".repeat(64)}`, `sha256:${"A".repeat(64)}`, "v2026.925.0"]) {
    assert.throws(() => imageReleaseSection("2026.925.0", bad), /digest/);
  }
});

test("CLI prints one tag per line and fails loudly on bad input", () => {
  const out = execFileSync("node", [SCRIPT, "tags", "2026.925.0", "--repo", "ghcr.io/example/app"], { encoding: "utf8" });
  assert.equal(out, "ghcr.io/example/app:v2026.925.0\nghcr.io/example/app:2026.925.0\n");
  const bad = spawnSync("node", [SCRIPT, "section", "2026.925.0", "sha256:nope"], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /image digest must be/);
  const usage = spawnSync("node", [SCRIPT, "push"], { encoding: "utf8" });
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /usage:/);
});
