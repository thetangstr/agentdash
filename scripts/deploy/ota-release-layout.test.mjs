// Immutable release directories.
//
// The export test is the one that matters: it asserts a materialized release
// contains no `.git`. That absence is the whole mechanism — it is what makes it
// impossible for a developer's `git checkout`, or the updater's own
// `checkout --detach`, to change what a running instance serves.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import {
  CURRENT_LINK_NAME,
  DEFAULT_KEEP_RELEASES,
  exportRelease,
  planPrune,
  planReleaseLayout,
  readCurrent,
  releaseDirName,
  releaseNameForPath,
  resolveTagCommit,
  swapCurrent,
} from "./ota-release-layout.mjs";

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A tiny repo with one tagged commit, so the export path is exercised for real. */
function makeRepo() {
  const dir = tempDir("ota-repo-");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env });
  mkdirSync(path.join(dir, "server"), { recursive: true });
  writeFileSync(path.join(dir, "server", "index.js"), "console.log('v1');\n");
  git("add", ".");
  git("commit", "-qm", "first");
  git("tag", "v2026.827.2");
  return { dir, commit: git("rev-parse", "HEAD").trim() };
}

test("releaseDirName combines tag and short commit", () => {
  assert.equal(
    releaseDirName("v2026.827.2", "4637abd727dfe98b4865bec30a39cd772c484749"),
    "v2026.827.2-4637abd7",
  );
});

test("releaseDirName refuses a missing tag or a short commit", () => {
  assert.throws(() => releaseDirName("", "4637abd727dfe98b"), /tag/);
  assert.throws(() => releaseDirName("v2026.827.2", "abc"), /commit/);
});

test("planReleaseLayout keeps staging out of the way of finished releases", () => {
  const layout = planReleaseLayout({
    releasesRoot: "/opt/releases",
    tag: "v2026.827.2",
    commit: "4637abd727dfe98b4865bec30a39cd772c484749",
  });
  assert.equal(layout.releaseDir, "/opt/releases/v2026.827.2-4637abd7");
  assert.equal(layout.stagingDir, "/opt/releases/.staging-v2026.827.2-4637abd7");
  assert.equal(layout.currentLink, `/opt/releases/${CURRENT_LINK_NAME}`);
});

test("releaseNameForPath identifies the release a path belongs to", () => {
  const root = "/opt/releases";
  assert.equal(
    releaseNameForPath(root, "/opt/releases/v2026.827.2-4637abd7/server"),
    "v2026.827.2-4637abd7",
  );
  // A developer checkout is not a release, which is exactly the distinction
  // the status endpoint relies on.
  assert.equal(releaseNameForPath(root, "/Users/yang/agentdash/server"), null);
  assert.equal(releaseNameForPath(root, null), null);
  assert.equal(releaseNameForPath(root, "/opt/releases/current/server"), null);
  assert.equal(releaseNameForPath(root, "/opt/releases/.staging-v1-abc/server"), null);
});

test("exportRelease materializes a commit with no .git, so it cannot be checked out", () => {
  const repo = makeRepo();
  const releasesRoot = tempDir("ota-releases-");
  try {
    const result = exportRelease({
      repoDir: repo.dir,
      tag: "v2026.827.2",
      commit: repo.commit,
      releasesRoot,
    });
    assert.equal(result.reused, false);
    assert.ok(existsSync(path.join(result.releaseDir, "server", "index.js")));
    // The point of the whole exercise.
    assert.equal(existsSync(path.join(result.releaseDir, ".git")), false);
    assert.match(readFileSync(path.join(result.releaseDir, "server", "index.js"), "utf8"), /v1/);
    // Staging must not survive a successful export.
    assert.equal(existsSync(result.stagingDir), false);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(releasesRoot, { recursive: true, force: true });
  }
});

test("exportRelease is idempotent", () => {
  const repo = makeRepo();
  const releasesRoot = tempDir("ota-releases-");
  try {
    const args = { repoDir: repo.dir, tag: "v2026.827.2", commit: repo.commit, releasesRoot };
    assert.equal(exportRelease(args).reused, false);
    assert.equal(exportRelease(args).reused, true);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(releasesRoot, { recursive: true, force: true });
  }
});

test("resolveTagCommit resolves a tag and throws for one that does not exist", () => {
  const repo = makeRepo();
  try {
    assert.equal(resolveTagCommit(repo.dir, "v2026.827.2"), repo.commit);
    assert.throws(() => resolveTagCommit(repo.dir, "v2026.999.9"));
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("swapCurrent points current at a release and reports the previous target", () => {
  const releasesRoot = tempDir("ota-releases-");
  try {
    const a = path.join(releasesRoot, "v2026.827.1-aaaaaaaa");
    const b = path.join(releasesRoot, "v2026.827.2-bbbbbbbb");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });

    const first = swapCurrent({ releasesRoot, releaseDir: a });
    assert.equal(first.previous, null);
    assert.equal(readCurrent(releasesRoot), a);

    const second = swapCurrent({ releasesRoot, releaseDir: b });
    assert.equal(second.previous, a);
    assert.equal(readCurrent(releasesRoot), b);

    // Rollback is exactly this, in the other direction.
    const back = swapCurrent({ releasesRoot, releaseDir: a });
    assert.equal(back.previous, b);
    assert.equal(readCurrent(releasesRoot), a);
  } finally {
    rmSync(releasesRoot, { recursive: true, force: true });
  }
});

test("readCurrent is null when current has never been set", () => {
  const releasesRoot = tempDir("ota-releases-");
  try {
    assert.equal(readCurrent(releasesRoot), null);
  } finally {
    rmSync(releasesRoot, { recursive: true, force: true });
  }
});

const PRUNE_NAMES = [
  "v2026.820.0-aaaaaaaa",
  "v2026.821.0-bbbbbbbb",
  "v2026.822.0-cccccccc",
  "v2026.823.0-dddddddd",
  "v2026.824.0-eeeeeeee",
  "v2026.825.0-ffffffff",
  "v2026.826.0-99999999",
];

test("planPrune keeps the newest N and removes the rest", () => {
  assert.deepEqual(planPrune({ releaseNames: PRUNE_NAMES, keep: 3 }), [
    "v2026.823.0-dddddddd",
    "v2026.822.0-cccccccc",
    "v2026.821.0-bbbbbbbb",
    "v2026.820.0-aaaaaaaa",
  ]);
});

test("planPrune never removes a protected release however old it is", () => {
  // Deleting the rollback target would turn a symlink swap into a rebuild.
  const remove = planPrune({
    releaseNames: PRUNE_NAMES,
    keep: 2,
    protectedNames: ["v2026.820.0-aaaaaaaa"],
  });
  assert.equal(remove.includes("v2026.820.0-aaaaaaaa"), false);
});

test("planPrune removes nothing when there are fewer releases than the keep count", () => {
  assert.deepEqual(planPrune({ releaseNames: PRUNE_NAMES.slice(0, 2), keep: DEFAULT_KEEP_RELEASES }), []);
});
