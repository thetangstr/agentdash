import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { buildUpdatePlan, defaultRestartCommand, selfInstall } from "./agentdash-source-update.mjs";

const BASE = {
  repoDir: "/Users/yang/agentdash",
  stateDir: "/tmp/agentdash-state",
  currentSha: "aaaaaaa",
  remoteSha: "bbbbbbb",
};

test("plan: updating to the branch tip is the default action", () => {
  const plan = buildUpdatePlan(BASE, {});
  assert.equal(plan.action, "update");
  assert.equal(plan.targetSha, "bbbbbbb");
  assert.equal(plan.remote, "origin");
  assert.equal(plan.branch, "main");
});

test("plan: already at the tip is a noop, not a restart of a healthy server", () => {
  const plan = buildUpdatePlan({ ...BASE, remoteSha: "aaaaaaa" }, {});
  assert.equal(plan.action, "noop");
});

test("plan: --force applies even when already at the target", () => {
  const plan = buildUpdatePlan({ ...BASE, remoteSha: "aaaaaaa", force: true }, {});
  assert.equal(plan.action, "update");
});

test("plan: an explicit target beats the remote tip", () => {
  const plan = buildUpdatePlan({ ...BASE, targetSha: "ccccccc" }, {});
  assert.equal(plan.targetSha, "ccccccc");
});

test("plan: rollback goes to the previously recorded commit", () => {
  const plan = buildUpdatePlan({ ...BASE, rollback: true }, { currentSha: "bbbbbbb", previousSha: "aaaaaaa" });
  assert.equal(plan.action, "rollback");
  assert.equal(plan.targetSha, "aaaaaaa");
});

test("plan: rollback with nothing recorded refuses rather than guessing", () => {
  assert.throws(
    () => buildUpdatePlan({ ...BASE, rollback: true }, {}),
    /nothing to roll back to/i,
  );
});

test("plan: rollback accepts an explicit commit", () => {
  const plan = buildUpdatePlan({ ...BASE, rollback: true, rollbackToSha: "ddddddd" }, {});
  assert.equal(plan.targetSha, "ddddddd");
});

test("plan: refuses when no target can be resolved at all", () => {
  assert.throws(
    () => buildUpdatePlan({ repoDir: "/x", stateDir: "/y", currentSha: "aaa" }, {}),
    /No target commit resolved/i,
  );
});

test("plan: health url is derived from the base url", () => {
  const plan = buildUpdatePlan({ ...BASE, baseUrl: "https://board.example.com:3112/" }, {});
  assert.equal(plan.healthUrl, "https://board.example.com:3112/api/health");
});

test("plan: defaults health to loopback on the app port, not the public URL", () => {
  // The updater runs on the box. Loopback does not depend on DNS, Tailscale, or
  // certificate trust — all three of which have broken this deployment before.
  assert.equal(buildUpdatePlan(BASE, {}).healthUrl, "http://127.0.0.1:3102/api/health");
});

test("plan: state and receipts live under the state dir", () => {
  const plan = buildUpdatePlan(BASE, {});
  assert.equal(plan.statePath, path.join("/tmp/agentdash-state", "source-state.json"));
  assert.ok(plan.receiptPath.startsWith(path.join("/tmp/agentdash-state", "receipts")));
  assert.ok(plan.receiptPath.endsWith("-source-update.json"));
});

test("plan: the default state dir is under the operator's home", () => {
  const plan = buildUpdatePlan({ repoDir: "/x", currentSha: "a", remoteSha: "b" }, {});
  assert.equal(plan.statePath, path.join(os.homedir(), ".agentdash", "deployments", "source-state.json"));
});

test("restart command kills the listener and its parent", () => {
  // Killing only the listener leaves the pnpm wrapper alive, and launchd then
  // believes the job is still running while the port sits silent.
  const command = defaultRestartCommand(3102);
  assert.match(command, /lsof -nP -iTCP:3102 -sTCP:LISTEN -t/);
  assert.match(command, /ppid=/);
  assert.match(command, /kill -9/);
});

test("backup and dirty-tree posture are carried on the plan, not assumed", () => {
  const strict = buildUpdatePlan(BASE, {});
  assert.equal(strict.skipBackup, false);
  assert.equal(strict.allowDirty, false);

  const loose = buildUpdatePlan({ ...BASE, skipBackup: true, allowDirty: true }, {});
  assert.equal(loose.skipBackup, true);
  assert.equal(loose.allowDirty, true);
});

test("selfInstall keeps an executable copy outside the checkout it updates", () => {
  // The first live rollback attempt died with MODULE_NOT_FOUND: the update
  // before it had checked out a commit where the updater did not exist yet.
  // The tool that repairs a half-finished update cannot live only inside it.
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentdash-selfinstall-"));
  try {
    const target = path.join(dir, "bin", "agentdash-source-update.mjs");
    const written = selfInstall(new URL(import.meta.url).pathname, target);
    assert.equal(written, target);
    assert.ok(existsSync(target));
    assert.equal(statSync(target).mode & 0o111, 0o111, "installed copy must be executable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
