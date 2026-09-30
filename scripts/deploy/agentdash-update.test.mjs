// The scheduled update wrapper (deploy/agentdash-update.sh).
//
// The daily job refreshed its updater copies from the source clone, which an
// apply never updates and which therefore drifts behind the serving release.
// The check it ran was a retired updater reporting a commit nothing was
// serving. The
// wrapper now installs the copies from releases/current and keeps the clone
// only as the fetch source (`--repo-dir`).
//
// Every path is a temp dir and the "updater" is a stub that prints its argv, so
// nothing here fetches, writes deployment state, or touches a real install.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const WRAPPER = path.join(REPO_ROOT, "deploy", "agentdash-update.sh");
// Production runs it under zsh (its shebang). CI images may not ship zsh; the
// wrapper is plain POSIX sh apart from that line, so bash exercises the same code.
const SHELL = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";

function stubUpdater(dir, from) {
  mkdirSync(path.join(dir, "scripts", "deploy"), { recursive: true });
  writeFileSync(
    path.join(dir, "scripts", "deploy", "ota-apply.mjs"),
    `console.log(JSON.stringify({ from: ${JSON.stringify(from)}, argv: process.argv.slice(2) }));\n`,
  );
  writeFileSync(path.join(dir, "scripts", "deploy", "ota-release-layout.mjs"), `// ${from}\n`);
}

function makeBox({ withCurrent }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentdash-update-test-"));
  const box = {
    root,
    home: path.join(root, "home"),
    clone: path.join(root, "clone"),
    releasesRoot: path.join(root, "releases"),
    binDir: path.join(root, "bin"),
    stateDir: path.join(root, "deployments"),
  };
  mkdirSync(box.home, { recursive: true });
  mkdirSync(box.releasesRoot, { recursive: true });
  stubUpdater(box.clone, "clone");
  if (withCurrent) {
    const release = path.join(box.releasesRoot, "v2026.901.0-aaaaaaaa");
    stubUpdater(release, "release");
    symlinkSync(release, path.join(box.releasesRoot, "current"));
  }
  return box;
}

function runWrapper(box, extraEnv = {}) {
  const out = execFileSync(SHELL, [WRAPPER], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: box.home,
      AGENTDASH_ENV_FILE: path.join(box.root, "no-such.env"),
      AGENTDASH_APP_DIR: box.clone,
      AGENTDASH_BIN_DIR: box.binDir,
      AGENTDASH_RELEASES_ROOT: box.releasesRoot,
      AGENTDASH_OTA_STATE_DIR: box.stateDir,
      ...extraEnv,
    },
  });
  const line = out.split("\n").find((l) => l.startsWith("{"));
  return { out, updater: JSON.parse(line) };
}

test("the daily check runs the serving release's updater, not the clone's", () => {
  const box = makeBox({ withCurrent: true });
  try {
    const { updater } = runWrapper(box, { AGENTDASH_REPO_DIR: box.clone });
    assert.equal(updater.from, "release");
    assert.equal(readFileSync(path.join(box.binDir, "ota-release-layout.mjs"), "utf8"), "// release\n");
    // The clone is still the fetch source; that is the only thing it is used for.
    assert.deepEqual(updater.argv, [
      "--repo-dir", box.clone,
      "--releases-root", box.releasesRoot,
      "--state-dir", box.stateDir,
      "--check",
    ]);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("a box with no release yet still refreshes the updater from the checkout", () => {
  const box = makeBox({ withCurrent: false });
  try {
    const { updater } = runWrapper(box);
    assert.equal(updater.from, "clone");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("--repo-dir falls back to AGENTDASH_APP_DIR for plists written before AGENTDASH_REPO_DIR existed", () => {
  const box = makeBox({ withCurrent: true });
  try {
    const { updater } = runWrapper(box);
    assert.equal(updater.argv[1], box.clone);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});
