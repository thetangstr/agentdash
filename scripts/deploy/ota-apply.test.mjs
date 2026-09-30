// The apply path, with every side effect injected.
//
// The test that matters most is "failed health rolls back to the previous
// release". A rollback that has never actually executed is a plan, not a
// capability, and the one thing this orchestrator must be able to do reliably
// is fail safely. Driving it with fakes is what makes that provable on every CI
// run instead of once, by hand, on a host.
//
// The `order` array in the harness exists for the same reason: several of the
// safety properties are about SEQUENCE, not outcome. A backup taken after the
// switch backs up the wrong thing; a build run after the switch means a build
// failure is an outage. Asserting the recorded order is how those stay true.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import {
  approvalAuthorizes,
  evaluateMigrationPolicy,
  pendingMigrationsBetween,
  readJournalTags,
  runApply,
} from "./ota-apply.mjs";

const COMMIT = "4637abd727dfe98b4865bec30a39cd772c484749";
const PREV_DIR = "/releases/v2026.827.1-e912d614";
const NEW_DIR = "/releases/v2026.827.2-4637abd7";

function writeJournal(root, tags) {
  const dir = path.join(root, "packages", "db", "src", "migrations", "meta");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries: tags.map((tag, idx) => ({ idx, tag })) }),
  );
}

function tempRoot(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A harness where nothing touches a disk, a service, or a network.
 * `order` records the stages that actually ran, in sequence.
 */
function harness(overrides = {}) {
  const order = [];
  // `in`, not `??`: a test that deliberately starts with no current release
  // passes null, and `??` would quietly turn that back into PREV_DIR — which
  // is exactly how the no-previous-release path went untested.
  const state = {
    current: "startingCurrent" in overrides ? overrides.startingCurrent : PREV_DIR,
  };
  const base = {
    resolveTagCommit: () => COMMIT,
    commitIsOnMain: () => true,
    exportRelease: () => ({ releaseDir: NEW_DIR, stagingDir: `${NEW_DIR}.staging`, reused: false }),
    buildRelease: () => {},
    sealRelease: () => {},
    writeReleaseMarker: () => {},
    readReleaseMarker: () => null,
    removeRelease: () => {},
    pruneReleases: () => ({ planned: [], removed: [], held: false }),
    releasesInUse: () => [],
    releasesInPlists: () => [],
    installUpdaterTools: ({ binDir }) => ({ binDir, installed: [] }),
    // Never the real launchctl/lsof/kill: every default-restart test fakes both.
    planServiceRestart: () => ({ ok: true, target: "system/fake", kill: [], detail: "fake plan" }),
    restartService: () => ({ restarted: true, detail: "fake restart" }),
    readCurrent: () => state.current,
    swapCurrent: ({ releaseDir }) => {
      const previous = state.current;
      state.current = releaseDir;
      return { link: "/releases/current", previous, now: releaseDir };
    },
    runCommand: () => {},
    checkHealth: async () => ({ ok: true, detail: "HTTP 200" }),
    now: () => "2026-09-02T00:00:00.000Z",
    log: () => {},
  };
  const merged = { ...base, ...overrides.deps };

  // Recording lives in the wrappers, not the defaults, so a test that overrides
  // a stage still shows up in `order`. Getting this wrong once already made five
  // ordering assertions silently compare against a short list.
  const deps = {
    ...merged,
    exportRelease: (...args) => {
      order.push("export");
      return merged.exportRelease(...args);
    },
    buildRelease: (...args) => {
      order.push("build");
      return merged.buildRelease(...args);
    },
    sealRelease: (...args) => {
      order.push("seal");
      return merged.sealRelease(...args);
    },
    writeReleaseMarker: (...args) => {
      order.push("marker");
      return merged.writeReleaseMarker(...args);
    },
    removeRelease: (...args) => {
      order.push(`remove:${args[0]}`);
      return merged.removeRelease(...args);
    },
    pruneReleases: (...args) => {
      order.push("prune");
      return merged.pruneReleases(...args);
    },
    installUpdaterTools: (...args) => {
      order.push("install_updater");
      return merged.installUpdaterTools(...args);
    },
    swapCurrent: (...args) => {
      order.push(`swap:${args[0].releaseDir}`);
      return merged.swapCurrent(...args);
    },
    runCommand: (cmd, label) => {
      order.push(label);
      return merged.runCommand(cmd, label);
    },
    restartService: (...args) => {
      order.push("restart");
      return merged.restartService(...args);
    },
  };
  return { deps, order, state };
}

function baseInput(stateDir, extra = {}) {
  return {
    repoDir: "/repo",
    releasesRoot: "/releases",
    stateDir,
    tag: "v2026.827.2",
    baseUrl: "http://127.0.0.1:3102",
    restartCommand: "restart",
    backupCommand: "backup",
    installedRoot: "/installed",
    requireApproval: false,
    ...extra,
  };
}

/** A state dir holding an approved approval for the release under test. */
function approvedStateDir(overrides = {}) {
  const dir = tempRoot("ota-apply-state-");
  writeFileSync(
    path.join(dir, "pending-approval.json"),
    JSON.stringify({
      id: "a1",
      tag: "v2026.827.2",
      commit: COMMIT,
      channel: "stable",
      status: "approved",
      requestedByUserId: "u1",
      requestedAt: "2026-09-02T00:00:00Z",
      decidedByUserId: "u1",
      decidedAt: "2026-09-02T00:01:00Z",
      approvedVerdict: "compatible",
      ...overrides,
    }),
  );
  return dir;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("readJournalTags returns ordered tags, or null when unreadable", () => {
  const root = tempRoot("ota-journal-");
  try {
    writeJournal(root, ["0001_a", "0002_b"]);
    assert.deepEqual(readJournalTags(root), ["0001_a", "0002_b"]);
    assert.equal(readJournalTags(tempRoot("ota-empty-")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pendingMigrationsBetween reports only what the target adds", () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  try {
    writeJournal(installed, ["0001_a", "0002_b"]);
    writeJournal(target, ["0001_a", "0002_b", "0003_c"]);
    assert.deepEqual(pendingMigrationsBetween(installed, target), ["0003_c"]);
    writeJournal(target, ["0001_a", "0002_b"]);
    assert.deepEqual(pendingMigrationsBetween(installed, target), []);
  } finally {
    rmSync(installed, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("pendingMigrationsBetween is null when either journal is unreadable", () => {
  const installed = tempRoot("ota-installed-");
  try {
    writeJournal(installed, ["0001_a"]);
    assert.equal(pendingMigrationsBetween(installed, tempRoot("ota-none-")), null);
  } finally {
    rmSync(installed, { recursive: true, force: true });
  }
});

test("migration policy refuses pending migrations by default and explains why", () => {
  const verdict = evaluateMigrationPolicy({ pending: ["0003_c"], allowMigrations: false });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.verdict, "forward_only");
  assert.match(verdict.reason, /--allow-migrations/);
  assert.match(verdict.reason, /restores code only/);
});

test("migration policy allows migrations only when explicitly permitted", () => {
  const verdict = evaluateMigrationPolicy({ pending: ["0003_c"], allowMigrations: true });
  assert.equal(verdict.ok, true);
  assert.match(verdict.reason, /discard data written after it/);
});

test("migration policy passes cleanly when nothing is pending", () => {
  const verdict = evaluateMigrationPolicy({ pending: [], allowMigrations: false });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.verdict, "compatible");
});

test("migration policy refuses when the journals could not be read", () => {
  const verdict = evaluateMigrationPolicy({ pending: null, allowMigrations: true });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.verdict, "unknown");
});

test("approvalAuthorizes binds to the exact commit and tag", () => {
  const approval = { status: "approved", commit: COMMIT, tag: "v2026.827.2" };
  assert.equal(approvalAuthorizes({ approval, tag: "v2026.827.2", commit: COMMIT }).ok, true);
  assert.equal(approvalAuthorizes({ approval: null, tag: "v2026.827.2", commit: COMMIT }).ok, false);
  assert.equal(
    approvalAuthorizes({ approval: { ...approval, status: "pending" }, tag: "v2026.827.2", commit: COMMIT }).ok,
    false,
  );
  assert.equal(
    approvalAuthorizes({ approval: { ...approval, commit: "0".repeat(40) }, tag: "v2026.827.2", commit: COMMIT }).ok,
    false,
  );
});

// ---------------------------------------------------------------------------
// Gates that must refuse before anything is mutated
// ---------------------------------------------------------------------------

test("refuses a commit that is not on origin/main, before touching anything", async () => {
  const { deps, order } = harness({ deps: { commitIsOnMain: () => false } });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir), deps);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failedStage, "provenance");
    assert.deepEqual(order, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("refuses a tag that is not a release tag", async () => {
  const { deps, order } = harness();
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { tag: "nightly" }), deps);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failedStage, "provenance");
    assert.deepEqual(order, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("refuses without an approval when the gate is on", async () => {
  const { deps, order } = harness();
  const stateDir = tempRoot("ota-noapproval-");
  try {
    const result = await runApply(baseInput(stateDir, { requireApproval: true }), deps);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failedStage, "approval");
    assert.match(result.error, /A human must approve/);
    assert.deepEqual(order, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("accepts a matching approval", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  const { deps } = harness({
    deps: { exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }) },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(
      baseInput(stateDir, { requireApproval: true, installedRoot: installed }),
      deps,
    );
    assert.equal(result.outcome, "applied");
    assert.ok(result.checks.find((c) => c.name === "approval" && c.status === "passed"));
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("refuses a migrating release by default, after export but before backup", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a", "0002_new"]);
  const { deps, order } = harness({
    deps: { exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }) },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed }), deps);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failedStage, "compatibility");
    assert.deepEqual(result.pendingMigrations, ["0002_new"]);
    // Exported (harmless), but never backed up, built, or switched.
    assert.deepEqual(order, ["export"]);
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("a failed backup stops the update before anything switches", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  const { deps, order, state } = harness({
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      runCommand: (_cmd, label) => {
        if (label === "backup") throw new Error("pg_dump exploded");
      },
    },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed }), deps);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failedStage, "backup");
    assert.equal(state.current, PREV_DIR, "current must not have moved");
    assert.equal(order.includes("build"), false);
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("refuses to run with no backup configured unless skipping is deliberate", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  const { deps } = harness({
    deps: { exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }) },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(
      { ...baseInput(stateDir, { installedRoot: installed }), backupCommand: undefined },
      deps,
    );
    assert.equal(result.outcome, "failed");
    assert.equal(result.failedStage, "backup");
    assert.match(result.error, /--skip-backup/);
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("a build failure leaves the running release untouched", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  const { deps, state } = harness({
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      buildRelease: () => {
        throw new Error("tsc failed");
      },
    },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed }), deps);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failedStage, "materialize");
    assert.match(result.error, /nothing was switched/);
    assert.equal(state.current, PREV_DIR);
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

// ---------------------------------------------------------------------------
// Applying, and failing safely
// ---------------------------------------------------------------------------

test("a healthy update applies, in the right order", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  const { deps, order, state } = harness({
    deps: { exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }) },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed }), deps);
    assert.equal(result.outcome, "applied");
    assert.equal(result.commit, COMMIT);
    assert.equal(state.current, target);
    // Backup precedes build precedes switch precedes restart. The completion
    // marker is written only once the build and seal are done, and pruning
    // happens only after health has passed.
    assert.deepEqual(order, ["export", "backup", "build", "seal", "marker", `swap:${target}`, "restart", "prune"]);
    // Never claimed.
    assert.equal(result.signatureVerified, false);
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("ROLLBACK PROOF: a failed health check restores the previous release", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);

  // Unhealthy on the new release, healthy again once rolled back — exactly the
  // shape of a bad deploy.
  let healthCalls = 0;
  const { deps, order, state } = harness({
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      checkHealth: async () => {
        healthCalls += 1;
        return healthCalls === 1
          ? { ok: false, detail: "HTTP 500" }
          : { ok: true, detail: "HTTP 200" };
      },
    },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed }), deps);

    assert.equal(result.outcome, "rolled_back");
    assert.equal(state.current, PREV_DIR, "current must be back on the previous release");
    assert.equal(result.releaseDir, PREV_DIR);
    assert.equal(result.attemptedReleaseDir, target);
    assert.match(result.error, /rolled back to the previous release/);

    // The sequence a reviewer should be able to read off the receipt.
    assert.deepEqual(order, [
      "export",
      "backup",
      "build",
      "seal",
      "marker",
      `swap:${target}`,
      "restart",
      `swap:${PREV_DIR}`,
      "restart",
    ]);
    const names = result.checks.map((c) => `${c.name}:${c.status}`);
    assert.ok(names.includes("health:failed"));
    assert.ok(names.includes("rollback_switch:passed"));
    assert.ok(names.includes("rollback_health:passed"));
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("says so plainly when the rollback itself does not recover", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  const { deps } = harness({
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      checkHealth: async () => ({ ok: false, detail: "HTTP 500" }),
    },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed }), deps);
    assert.equal(result.outcome, "failed");
    assert.match(result.error, /rollback did not recover/);
    assert.match(result.error, /Manual recovery required/);
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("a first-ever deploy with nothing to fall back to fails loudly rather than silently", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  const { deps } = harness({
    startingCurrent: null,
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      checkHealth: async () => ({ ok: false, detail: "HTTP 500" }),
    },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed }), deps);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failedStage, "rollback");
    assert.match(result.error, /no previous release/);
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("dry run stops before the backup and switches nothing", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  const { deps, order, state } = harness({
    deps: { exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }) },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed, dryRun: true }), deps);
    assert.equal(result.outcome, "noop");
    assert.equal(result.dryRun, true);
    assert.deepEqual(order, ["export"]);
    assert.equal(state.current, PREV_DIR);
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

// ---------------------------------------------------------------------------
// Direction: an "update" must not quietly revert a host
// ---------------------------------------------------------------------------
//
// This guard exists because of a real observation on this project: every
// v2026.827.x tag resolves to the SAME commit, and the newest tag is BEHIND
// origin/main. So "apply the newest release" is not automatically forward
// motion, and the failure it would produce — a host silently reverted by its
// own updater — is the exact failure the release-identity work set out to end.

import { execFileSync } from "node:child_process";
import { assessUpdateDirection } from "./ota-apply.mjs";

/** Two commits, one an ancestor of the other, plus a diverged branch. */
function makeHistory() {
  const dir = tempRoot("ota-history-");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env });
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "first");
  const older = git("rev-parse", "HEAD");
  writeFileSync(path.join(dir, "a.txt"), "two\n");
  git("add", ".");
  git("commit", "-qm", "second");
  const newer = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "side", older);
  writeFileSync(path.join(dir, "b.txt"), "side\n");
  git("add", ".");
  git("commit", "-qm", "side");
  const diverged = git("rev-parse", "HEAD");
  return { dir, older, newer, diverged };
}

test("direction: a descendant target is forward and allowed", () => {
  const h = makeHistory();
  try {
    const verdict = assessUpdateDirection(h.dir, h.older, h.newer);
    assert.equal(verdict.direction, "forward");
    assert.equal(verdict.ok, true);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("direction: an ancestor target is a downgrade and is refused", () => {
  const h = makeHistory();
  try {
    const verdict = assessUpdateDirection(h.dir, h.newer, h.older);
    assert.equal(verdict.direction, "backward");
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /revert the instance/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("direction: the same commit is a no-op, not a downgrade", () => {
  const h = makeHistory();
  try {
    const verdict = assessUpdateDirection(h.dir, h.newer, h.newer);
    assert.equal(verdict.direction, "same");
    assert.equal(verdict.ok, true);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("direction: diverged histories are neither an update nor a rollback", () => {
  const h = makeHistory();
  try {
    const verdict = assessUpdateDirection(h.dir, h.newer, h.diverged);
    assert.equal(verdict.direction, "diverged");
    assert.equal(verdict.ok, false);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("direction: no installed commit on record is treated as a first install", () => {
  const h = makeHistory();
  try {
    assert.equal(assessUpdateDirection(h.dir, null, h.newer).ok, true);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("runApply refuses a downgrade before touching anything", async () => {
  const h = makeHistory();
  const stateDir = tempRoot("ota-downgrade-");
  try {
    // State says we are on the newer commit; the target resolves to the older.
    writeFileSync(
      path.join(stateDir, "deployment-state.json"),
      JSON.stringify({ schemaVersion: 2, current: { commit: h.newer } }),
    );
    const { deps, order } = harness({
      deps: { resolveTagCommit: () => h.older, commitIsOnMain: () => true },
    });
    const result = await runApply(
      { ...baseInput(stateDir, { installedRoot: h.dir }), repoDir: h.dir },
      deps,
    );
    assert.equal(result.outcome, "failed");
    assert.equal(result.failedStage, "direction");
    assert.equal(result.direction, "backward");
    assert.deepEqual(order, [], "nothing may be exported, backed up, or switched");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("runApply reports a no-op when already on the target commit", async () => {
  const h = makeHistory();
  const stateDir = tempRoot("ota-noop-");
  try {
    writeFileSync(
      path.join(stateDir, "deployment-state.json"),
      JSON.stringify({ schemaVersion: 2, current: { commit: h.newer } }),
    );
    const { deps, order } = harness({
      deps: { resolveTagCommit: () => h.newer, commitIsOnMain: () => true },
    });
    const result = await runApply(
      { ...baseInput(stateDir, { installedRoot: h.dir }), repoDir: h.dir },
      deps,
    );
    assert.equal(result.outcome, "noop");
    assert.deepEqual(order, []);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

import { persistOutcome } from "./ota-apply.mjs";
import { readFileSync, readdirSync } from "node:fs";

test("persistOutcome writes a receipt and advances state on a successful apply", () => {
  const stateDir = tempRoot("ota-receipt-");
  try {
    const written = persistOutcome({
      stateDir,
      result: {
        outcome: "applied",
        tag: "v2026.827.2",
        commit: COMMIT,
        releaseDir: NEW_DIR,
        previousReleaseDir: PREV_DIR,
        backupPath: "/backups/x.sql.gz",
        pendingMigrations: [],
        checks: [{ name: "health", status: "passed", completedAt: "2026-09-02T00:00:00.000Z" }],
        startedAt: "2026-09-02T00:00:00.000Z",
        finishedAt: "2026-09-02T00:05:00.000Z",
        error: null,
      },
    });
    assert.equal(written.error, null);
    const receipt = JSON.parse(readFileSync(written.receiptPath, "utf8"));
    assert.equal(receipt.outcome, "applied");
    assert.equal(receipt.to.commit, COMMIT);
    // The limitation belongs in the audit trail, not only in a document.
    assert.equal(receipt.signatureVerified, false);

    const state = JSON.parse(readFileSync(written.statePath, "utf8"));
    assert.equal(state.current.commit, COMMIT);
    assert.equal(state.current.version, "2026.827.2");
    assert.equal(state.lastReceiptPath, written.receiptPath);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("persistOutcome records a rollback but does NOT advance the installed state", () => {
  const stateDir = tempRoot("ota-receipt-rb-");
  try {
    writeFileSync(
      path.join(stateDir, "deployment-state.json"),
      JSON.stringify({ schemaVersion: 2, current: { commit: "old-commit" } }),
    );
    const written = persistOutcome({
      stateDir,
      result: {
        outcome: "rolled_back",
        tag: "v2026.827.2",
        commit: COMMIT,
        releaseDir: PREV_DIR,
        attemptedReleaseDir: NEW_DIR,
        checks: [],
        startedAt: "2026-09-02T00:00:00.000Z",
        finishedAt: "2026-09-02T00:05:00.000Z",
        error: "rolled back",
      },
    });
    const receipt = JSON.parse(readFileSync(written.receiptPath, "utf8"));
    assert.equal(receipt.outcome, "rolled_back");
    assert.equal(receipt.attemptedReleaseDir, NEW_DIR);
    assert.equal(written.statePath, null, "a rollback must not advance the recorded current release");
    const state = JSON.parse(readFileSync(path.join(stateDir, "deployment-state.json"), "utf8"));
    assert.equal(state.current.commit, "old-commit");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("persistOutcome writes a receipt even for a failure", () => {
  const stateDir = tempRoot("ota-receipt-fail-");
  try {
    const written = persistOutcome({
      stateDir,
      result: {
        outcome: "failed",
        tag: "v2026.827.2",
        commit: COMMIT,
        checks: [],
        startedAt: "2026-09-02T00:00:00.000Z",
        finishedAt: "2026-09-02T00:01:00.000Z",
        error: "backup failed",
      },
    });
    assert.ok(written.receiptPath);
    assert.equal(readdirSync(path.join(stateDir, "receipts")).length, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---- --check: the producer of available-release.json -------------------------
//
// The status endpoint is read-only by design, so the discovery half — fetch,
// pick the newest applicable tag, measure the diff — lives here. The two
// end-to-end tests run real git against a local `origin` remote, because the
// failure this file guards against is "the file nobody writes"; a fake that
// always writes it would prove nothing about the path a launchd job takes.

import { runCheck, persistOutcome as persistOutcomeForCheck } from "./ota-apply.mjs";

/** An origin repo with two commits on main and a release tag on the second. */
function makeOrigin() {
  const origin = tempRoot("ota-origin-");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  const git = (...args) => execFileSync("git", ["-C", origin, ...args], { encoding: "utf8", env }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", origin], { env });
  writeFileSync(path.join(origin, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "first");
  const older = git("rev-parse", "HEAD");
  // The candidate carries a migration journal, as a real release does.
  const journalDir = path.join(origin, "packages", "db", "src", "migrations", "meta");
  mkdirSync(journalDir, { recursive: true });
  writeFileSync(
    path.join(journalDir, "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, tag: "0000_init" }, { idx: 1, tag: "0001_more" }] }),
  );
  writeFileSync(path.join(origin, "a.txt"), "two\n");
  git("add", ".");
  git("commit", "-qm", "second");
  const newer = git("rev-parse", "HEAD");
  git("tag", "v2026.901.1");
  return { dir: origin, older, newer, env };
}

/** A work repo that fetches from the origin — what --check runs against. */
function makeWorkClone(originDir) {
  const work = tempRoot("ota-work-");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  execFileSync("git", ["-C", work, "remote", "add", "origin", originDir]);
  return work;
}

const NO_NOTES = { notes: "", url: null, publishedAt: null };

test("check: offers the newest release tag with diff and migration inventory (real git)", async () => {
  const origin = makeOrigin();
  const work = makeWorkClone(origin.dir);
  const stateDir = tempRoot("ota-check-state-");
  try {
    writeFileSync(
      path.join(stateDir, "deployment-state.json"),
      JSON.stringify({ schemaVersion: 2, current: { commit: origin.older } }),
    );
    const result = await runCheck(
      { repoDir: work, stateDir },
      { releaseNotes: () => NO_NOTES, now: () => "2026-09-23T00:00:00.000Z" },
    );

    const file = JSON.parse(readFileSync(path.join(stateDir, "available-release.json"), "utf8"));
    assert.equal(file.checkedAt, "2026-09-23T00:00:00.000Z");
    assert.equal(file.release.tag, "v2026.901.1");
    assert.equal(file.release.version, "2026.901.1");
    assert.equal(file.release.commit, origin.newer);
    assert.equal(file.release.channel, "stable");

    assert.equal(file.diff.commitCount, 1);
    assert.deepEqual(file.diff.commitSubjects, ["second"]);
    assert.equal(file.diff.truncated, false);
    assert.ok(file.diff.filesChanged >= 1);
    assert.ok(
      file.diff.migrationsAdded.some((p) => p.endsWith("meta/_journal.json")),
      "the new journal counts as a migration addition",
    );

    assert.deepEqual(
      file.releaseMigrations,
      [
        { id: "0000_init", name: "0000_init", reversible: false },
        { id: "0001_more", name: "0001_more", reversible: false },
      ],
    );
    assert.equal(result.written, path.join(stateDir, "available-release.json"));
  } finally {
    rmSync(origin.dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("check: writes release null when the instance is already on the newest tag (real git)", async () => {
  const origin = makeOrigin();
  const work = makeWorkClone(origin.dir);
  const stateDir = tempRoot("ota-check-state-");
  try {
    writeFileSync(
      path.join(stateDir, "deployment-state.json"),
      JSON.stringify({ schemaVersion: 2, current: { commit: origin.newer } }),
    );
    await runCheck({ repoDir: work, stateDir }, { releaseNotes: () => NO_NOTES });
    const file = JSON.parse(readFileSync(path.join(stateDir, "available-release.json"), "utf8"));
    assert.equal(file.release, null);
    assert.ok(file.checkedAt, "a null offer still says when it was computed");
  } finally {
    rmSync(origin.dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

/** git seams for runCheck, answered from a table. */
function fakeGit(outputs) {
  return (repoDir, args) => {
    const key = args.join(" ");
    if (key in outputs) {
      const value = outputs[key];
      if (value instanceof Error) throw value;
      return value;
    }
    throw new Error(`unexpected git call: ${key}`);
  };
}

test("check: skips a tag the direction guard would refuse and says why", async () => {
  const stateDir = tempRoot("ota-check-state-");
  try {
    writeFileSync(
      path.join(stateDir, "deployment-state.json"),
      JSON.stringify({ schemaVersion: 2, current: { commit: "installed" } }),
    );
    const result = await runCheck(
      { repoDir: "/repo", stateDir },
      {
        git: fakeGit({
          "fetch origin --tags": "",
          "tag --merged origin/main": "v2026.902.1",
        }),
        resolveTagCommit: () => "candidate",
        assessDirection: () => ({ direction: "backward", ok: false }),
        releaseNotes: () => NO_NOTES,
      },
    );
    assert.equal(result.release, null);
    assert.match(result.note, /v2026\.902\.1/);
    assert.match(result.note, /refuse/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("check: unreadable candidate journal is null, not an empty migration list", async () => {
  const stateDir = tempRoot("ota-check-state-");
  try {
    writeFileSync(
      path.join(stateDir, "deployment-state.json"),
      JSON.stringify({ schemaVersion: 2, current: { commit: "installed" } }),
    );
    const result = await runCheck(
      { repoDir: "/repo", stateDir },
      {
        git: fakeGit({
          "fetch origin --tags": "",
          "tag --merged origin/main": "v2026.902.1",
          "show candidate:packages/db/src/migrations/meta/_journal.json": new Error("no such path"),
          "diff --numstat installed..candidate": "3\t1\tsrc/x.ts\n",
          "log --format=%s installed..candidate": "change\n",
          "diff --name-only installed..candidate -- packages/db/src/migrations": "",
        }),
        resolveTagCommit: () => "candidate",
        assessDirection: () => ({ direction: "forward", ok: true }),
        releaseNotes: () => NO_NOTES,
      },
    );
    assert.equal(result.release.tag, "v2026.902.1");
    assert.equal(result.releaseMigrations, null, "unknown stays unknown so the planner blocks");
    assert.equal(result.diff.filesChanged, 1);
    assert.equal(result.diff.insertions, 3);
    assert.equal(result.diff.deletions, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("check: picks the newest tag by version order, not lexicographic", async () => {
  const stateDir = tempRoot("ota-check-state-");
  try {
    writeFileSync(
      path.join(stateDir, "deployment-state.json"),
      JSON.stringify({ schemaVersion: 2, current: { commit: "installed" } }),
    );
    const subjects = Array.from({ length: 25 }, (_, i) => `commit-${i}`).join("\n");
    const result = await runCheck(
      { repoDir: "/repo", stateDir },
      {
        git: fakeGit({
          "fetch origin --tags": "",
          // .10 must beat .9 and .2 despite sorting earlier as a string.
          "tag --merged origin/main": "v2026.901.9\nv2026.901.10\nv2026.901.2",
          "show cand:packages/db/src/migrations/meta/_journal.json":
            JSON.stringify({ entries: [{ idx: 0, tag: "0000_init" }] }),
          "diff --numstat installed..cand": "",
          "log --format=%s installed..cand": subjects,
          "diff --name-only installed..cand -- packages/db/src/migrations": "",
        }),
        resolveTagCommit: () => "cand",
        assessDirection: () => ({ direction: "forward", ok: true }),
        releaseNotes: () => NO_NOTES,
      },
    );
    assert.equal(result.release.tag, "v2026.901.10");
    assert.equal(result.diff.commitCount, 25);
    assert.equal(result.diff.commitSubjects.length, 20);
    assert.equal(result.diff.truncated, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("check: a failed fetch writes the error into the offer file instead of throwing", async () => {
  const stateDir = tempRoot("ota-check-state-");
  try {
    const result = await runCheck(
      { repoDir: "/repo", stateDir },
      {
        git: fakeGit({
          "fetch origin --tags": new Error("fatal: unable to connect"),
        }),
        now: () => "2026-09-23T00:00:00.000Z",
      },
    );
    const file = JSON.parse(readFileSync(path.join(stateDir, "available-release.json"), "utf8"));
    assert.equal(file.release, null, "a failed check must not look like a fresh offer");
    assert.equal(file.checkedAt, "2026-09-23T00:00:00.000Z");
    assert.match(file.error, /unable to connect/);
    assert.equal(result.error, file.error);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("check: reconciles the legacy source-state commit when no canonical state exists", async () => {
  const stateDir = tempRoot("ota-check-state-");
  try {
    writeFileSync(
      path.join(stateDir, "source-state.json"),
      JSON.stringify({ currentSha: "legacy-installed" }),
    );
    const result = await runCheck(
      { repoDir: "/repo", stateDir },
      {
        git: fakeGit({
          "fetch origin --tags": "",
          "tag --merged origin/main": "v2026.902.1",
          "show cand:packages/db/src/migrations/meta/_journal.json":
            JSON.stringify({ entries: [{ idx: 0, tag: "0000_init" }] }),
          "diff --numstat legacy-installed..cand": "",
          "log --format=%s legacy-installed..cand": "change\n",
          "diff --name-only legacy-installed..cand -- packages/db/src/migrations": "",
        }),
        resolveTagCommit: () => "cand",
        assessDirection: (repoDir, installed, target) => {
          assert.equal(installed, "legacy-installed", "the legacy record is the installed truth");
          return { direction: "forward", ok: true };
        },
        releaseNotes: () => NO_NOTES,
      },
    );
    assert.equal(result.release.tag, "v2026.902.1");
    assert.equal(result.diff.commitCount, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("check: checkout HEAD beats a stale source-state record", async () => {
  // A human pulled by hand: HEAD moved, source-state.json did not. The server
  // reconciles running-over-recorded (ota-deployment-state.ts) and the check
  // must agree — trusting the stale file would let the backward guard offer
  // an older tag.
  const stateDir = tempRoot("ota-check-state-");
  try {
    writeFileSync(
      path.join(stateDir, "source-state.json"),
      JSON.stringify({ currentSha: "stale-legacy" }),
    );
    const result = await runCheck(
      { repoDir: "/repo", stateDir },
      {
        git: fakeGit({
          "fetch origin --tags": "",
          "tag --merged origin/main": "v2026.902.1",
          "rev-parse HEAD": "actual-head",
          "show cand:packages/db/src/migrations/meta/_journal.json":
            JSON.stringify({ entries: [{ idx: 0, tag: "0000_init" }] }),
          "diff --numstat actual-head..cand": "",
          "log --format=%s actual-head..cand": "change\n",
          "diff --name-only actual-head..cand -- packages/db/src/migrations": "",
        }),
        resolveTagCommit: () => "cand",
        assessDirection: (repoDir, installed, target) => {
          assert.equal(installed, "actual-head", "the observed checkout wins over the stale record");
          return { direction: "forward", ok: true };
        },
        releaseNotes: () => NO_NOTES,
      },
    );
    assert.equal(result.release.tag, "v2026.902.1");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("check: falls back to the checkout HEAD on a box with no state file at all", async () => {
  const stateDir = tempRoot("ota-check-state-");
  try {
    const result = await runCheck(
      { repoDir: "/repo", stateDir },
      {
        git: fakeGit({
          "fetch origin --tags": "",
          "tag --merged origin/main": "v2026.902.1",
          "rev-parse HEAD": "checkout-head",
          "show cand:packages/db/src/migrations/meta/_journal.json":
            JSON.stringify({ entries: [{ idx: 0, tag: "0000_init" }] }),
          "diff --numstat checkout-head..cand": "",
          "log --format=%s checkout-head..cand": "change\n",
          "diff --name-only checkout-head..cand -- packages/db/src/migrations": "",
        }),
        resolveTagCommit: () => "cand",
        assessDirection: (repoDir, installed, target) => {
          assert.equal(installed, "checkout-head");
          return { direction: "forward", ok: true };
        },
        releaseNotes: () => NO_NOTES,
      },
    );
    assert.equal(result.release.tag, "v2026.902.1");
    assert.equal(result.diff.commitCount, 1, "the diff is measured from the checkout, not skipped");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("check: leaves no temp file beside the written offer", async () => {
  const stateDir = tempRoot("ota-check-state-");
  try {
    await runCheck(
      { repoDir: "/repo", stateDir },
      {
        git: fakeGit({
          "fetch origin --tags": "",
          "tag --merged origin/main": "",
          "rev-parse HEAD": "head",
        }),
        releaseNotes: () => NO_NOTES,
      },
    );
    const leftovers = readdirSync(stateDir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
    assert.ok(existsSync(path.join(stateDir, "available-release.json")));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("persistOutcome clears the offer after a successful apply", () => {
  const stateDir = tempRoot("ota-clear-");
  try {
    writeFileSync(
      path.join(stateDir, "available-release.json"),
      JSON.stringify({ release: { tag: "v2026.901.1", commit: COMMIT }, diff: {}, releaseMigrations: [], checkedAt: "earlier" }),
    );
    persistOutcomeForCheck({
      stateDir,
      result: {
        outcome: "applied",
        tag: "v2026.901.1",
        commit: COMMIT,
        releaseDir: NEW_DIR,
        checks: [],
        startedAt: "2026-09-23T00:00:00.000Z",
        finishedAt: "2026-09-23T00:05:00.000Z",
        error: null,
      },
    });
    const file = JSON.parse(readFileSync(path.join(stateDir, "available-release.json"), "utf8"));
    assert.equal(file.release, null, "the applied release must not keep being offered");
    assert.equal(file.checkedAt, "2026-09-23T00:05:00.000Z");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Restart command (#833.5)
// ---------------------------------------------------------------------------
//
// With no --restart-command, the restart ran `/bin/sh -c undefined`, which
// exits 127 — AFTER the switch, leaving the rollback as the only step that
// went right. The command is now defaulted or refused up front.

import { chmodSync, statSync } from "node:fs";
import {
  installUpdaterTools,
  parseLaunchctlPid,
  planServiceRestart,
  resolveRestartCommand,
  restartService,
  UPDATER_TOOL_FILES,
} from "./ota-apply.mjs";
import {
  exportRelease as realExportRelease,
  isCompletedRelease,
  readCurrent as realReadCurrent,
  readReleaseMarker as realReadReleaseMarker,
  removeReleaseDir as realRemoveReleaseDir,
  resolveTagCommit as realResolveTagCommit,
  sealRelease as realSealRelease,
  swapCurrent as realSwapCurrent,
  writeReleaseMarker as realWriteReleaseMarker,
} from "./ota-release-layout.mjs";

test("a missing restart command fails in dry-run, before anything is exported", async () => {
  const { deps, order } = harness();
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(
      baseInput(stateDir, { restartCommand: undefined, baseUrl: "https://mkmini.local", dryRun: true }),
      deps,
    );
    assert.equal(result.outcome, "failed");
    assert.equal(result.failedStage, "restart_command");
    assert.match(result.error, /--port|--restart-command/);
    assert.deepEqual(order, [], "nothing exported, backed up or switched");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a restart that cannot be verified fails in dry-run, before anything is exported", async () => {
  const { deps, order } = harness({
    deps: { planServiceRestart: () => ({ ok: false, reason: "The listener on port 3112 is pid 700 (caddy)." }) },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { restartCommand: undefined, dryRun: true }), deps);
    assert.equal(result.failedStage, "restart_command");
    assert.match(result.error, /caddy/);
    assert.deepEqual(order, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a restart that cannot be verified fails a real run before the backup", async () => {
  const { deps, order, state } = harness({
    deps: { planServiceRestart: () => ({ ok: false, reason: "not loaded" }) },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { restartCommand: undefined }), deps);
    assert.equal(result.failedStage, "restart_command");
    assert.ok(!order.includes("backup"));
    assert.equal(state.current, PREV_DIR);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an empty --restart-command is refused rather than run", async () => {
  const { deps, order } = harness();
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { restartCommand: "  " }), deps);
    assert.equal(result.failedStage, "restart_command");
    assert.deepEqual(order, []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("without --restart-command, the verified restart uses the base URL's port and the service label", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  const planned = [];
  const restarts = [];
  const { deps, order } = harness({
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      planServiceRestart: (args) => {
        planned.push(args);
        return { ok: true, target: "system/com.agentdash.mkboard.server", kill: [3, 2], detail: "kill 3 (node), 2 (node)" };
      },
      restartService: (args) => {
        restarts.push(args);
        return { restarted: true, detail: "killed" };
      },
    },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed, restartCommand: undefined }), deps);
    assert.equal(result.outcome, "applied");
    assert.deepEqual(planned, [{ port: 3102, label: "com.agentdash.mkboard.server" }]);
    assert.deepEqual(restarts, [{ port: 3102, label: "com.agentdash.mkboard.server", allowNothingRunning: false }]);
    assert.ok(order.includes("restart"));
    // The planned kill list is on the receipt before anything changed.
    assert.match(result.checks.find((c) => c.name === "restart_command").detail, /kill 3 \(node\)/);
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("resolveRestartCommand: an explicit command wins, --port beats the base URL, and a non-local URL derives nothing", () => {
  assert.deepEqual(
    resolveRestartCommand({ restartCommand: "restart-server.sh", baseUrl: "https://x" }),
    { ok: true, kind: "command", command: "restart-server.sh", detail: "--restart-command as given" },
  );
  const byPort = resolveRestartCommand({ port: "3200", baseUrl: "https://mkmini.local", serviceLabel: "com.x.server" });
  assert.deepEqual(byPort, { ok: true, kind: "service", port: 3200, label: "com.x.server", from: "--port" });
  assert.equal(resolveRestartCommand({ baseUrl: "http://localhost:3102" }).label, "com.agentdash.mkboard.server");
  assert.equal(resolveRestartCommand({ baseUrl: "https://mkmini.local:3112" }).ok, false);
  assert.equal(resolveRestartCommand({ baseUrl: "http://127.0.0.1" }).ok, false, "no explicit port");
  assert.equal(resolveRestartCommand({ port: "nope", baseUrl: "http://127.0.0.1:3102" }).ok, false);
  assert.equal(resolveRestartCommand({ baseUrl: "not a url" }).ok, false);
});

test("parseLaunchctlPid reads the running pid, and null when the job is not running", () => {
  assert.equal(parseLaunchctlPid("system/com.agentdash.mkboard.server = {\n\tstate = running\n\tpid = 5001\n}"), 5001);
  assert.equal(parseLaunchctlPid("gui/501/x = {\n\tstate = not running\n}"), null);
});

/**
 * An invented machine for the restart to inspect: `procs` maps pid ->
 * [ppid, command]; `ports` maps port -> listener pids; `jobs` maps launchd
 * target -> pid (or null when loaded but not running). Nothing real is read.
 */
function fakeProbe({ procs, ports, jobs }) {
  return {
    listeners: (port) => ports[port] ?? [],
    parentOf: (pid) => procs[pid]?.[0] ?? null,
    commandOf: (pid) => procs[pid]?.[1] ?? "",
    launchdJob: (label) => {
      for (const [target, pid] of Object.entries(jobs)) if (target.endsWith(`/${label}`)) return { target, pid };
      return null;
    },
  };
}

const LABEL = "com.agentdash.mkboard.server";
// A launchd-supervised server: node 5003 <- node 5002 <- pnpm 5001 <- launchd.
const BOX = {
  procs: {
    5003: [5002, "/opt/homebrew/Cellar/node@24/bin/node"],
    5002: [5001, "/opt/homebrew/Cellar/node@24/bin/node"],
    5001: [1, "/opt/homebrew/Cellar/node@24/bin/node"],
    700: [1, "/opt/homebrew/bin/caddy"],
  },
  ports: { 3102: [5003], 3112: [700] },
  jobs: { [`system/${LABEL}`]: 5001, "system/com.agentdash.caddy": 700 },
};

test("the verified restart kills exactly the listener up to the server's launchd job", () => {
  const plan = planServiceRestart({ port: 3102, label: LABEL, probe: fakeProbe(BOX) });
  assert.equal(plan.ok, true, plan.reason);
  assert.deepEqual(plan.kill, [5003, 5002, 5001]);
  assert.equal(plan.target, `system/${LABEL}`);
});

test("the verified restart finds a job installed in the user's GUI domain", () => {
  const probe = fakeProbe({ ...BOX, jobs: { [`gui/501/${LABEL}`]: 5001 } });
  const plan = planServiceRestart({ port: 3102, label: LABEL, probe });
  assert.equal(plan.ok, true);
  assert.equal(plan.target, `gui/501/${LABEL}`);
});

test("the verified restart refuses a --base-url on Caddy's port, killing nothing", () => {
  const plan = planServiceRestart({ port: 3112, label: LABEL, probe: fakeProbe(BOX) });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /pid 700 \(caddy\).*not part of system\/com\.agentdash\.mkboard\.server/);
});

test("the verified restart never kills Terminal: a server started by hand is not the launchd job", () => {
  // The daemon is down; a dev server runs in Terminal on the same port.
  const probe = fakeProbe({
    procs: {
      500: [400, "node"],
      400: [300, "pnpm"],
      300: [200, "-zsh"],
      200: [1, "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"],
    },
    ports: { 3102: [500] },
    jobs: { [`system/${LABEL}`]: null },
  });
  const plan = planServiceRestart({ port: 3102, label: LABEL, probe });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /loaded but not running/);
  // And with some unrelated pid reported for the job, the chain still does not reach it.
  const other = planServiceRestart({
    port: 3102,
    label: LABEL,
    probe: fakeProbe({ procs: { ...probe.procs, 9000: [1, "node"] }, ports: { 3102: [500] }, jobs: { [`system/${LABEL}`]: 9000 } }),
  });
  assert.equal(other.ok, false);
  assert.match(other.reason, /not part of/);
});

test("the verified restart never kills a tmux server, even if launchd reports it as the job", () => {
  // A misconfigured job whose pid is the tmux server: the chain reaches it, but tmux is never killed.
  const probe = fakeProbe({
    procs: { 500: [400, "node"], 400: [300, "zsh"], 300: [1, "/opt/homebrew/bin/tmux"] },
    ports: { 3102: [500] },
    jobs: { [`system/${LABEL}`]: 300 },
  });
  const plan = planServiceRestart({ port: 3102, label: LABEL, probe });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /pid 300 \(tmux\).*never kills/);
});

test("the verified restart refuses when the job is not loaded, nothing listens, or the job is not launchd's child", () => {
  assert.match(
    planServiceRestart({ port: 3102, label: LABEL, probe: fakeProbe({ ...BOX, jobs: {} }) }).reason,
    /not loaded/,
  );
  const quiet = planServiceRestart({ port: 3102, label: LABEL, probe: fakeProbe({ ...BOX, ports: {} }) });
  assert.equal(quiet.ok, false);
  assert.equal(quiet.nothingRunning, true);
  const nested = fakeProbe({ ...BOX, procs: { ...BOX.procs, 5001: [4000, "node"], 4000: [1, "zsh"] } });
  assert.match(planServiceRestart({ port: 3102, label: LABEL, probe: nested }).reason, /not a direct child of launchd/);
  const blind = { ...fakeProbe(BOX), listeners: () => null };
  assert.match(planServiceRestart({ port: 3102, label: LABEL, probe: blind }).reason, /lsof failed/);
});

test("restartService re-verifies, then SIGKILLs only the verified chain", () => {
  const killed = [];
  const result = restartService({
    port: 3102,
    label: LABEL,
    probe: fakeProbe(BOX),
    kill: (pid, signal) => killed.push([pid, signal]),
  });
  assert.equal(result.restarted, true);
  assert.deepEqual(killed, [[5003, "SIGKILL"], [5002, "SIGKILL"], [5001, "SIGKILL"]]);

  const refused = [];
  assert.throws(
    () => restartService({ port: 3112, label: LABEL, probe: fakeProbe(BOX), kill: (pid) => refused.push(pid) }),
    /caddy/,
  );
  assert.deepEqual(refused, [], "a refused plan kills nothing");
});

test("restartService in a rollback leaves a crashed job to launchd instead of failing", () => {
  const killed = [];
  const probe = fakeProbe({ ...BOX, ports: {} });
  const result = restartService({ port: 3102, label: LABEL, probe, allowNothingRunning: true, kill: (pid) => killed.push(pid) });
  assert.equal(result.restarted, false);
  assert.match(result.detail, /Leaving it to launchd/);
  assert.deepEqual(killed, []);
  assert.throws(() => restartService({ port: 3102, label: LABEL, probe, kill: () => {} }), /Nothing listens/);
});

test("ROLLBACK: a failed rollback restart is recorded, and health decides the outcome", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  let healthCalls = 0;
  let restarts = 0;
  const { deps, state } = harness({
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      restartService: () => {
        restarts += 1;
        if (restarts === 2) throw new Error("Nothing listens on port 3102");
        return { restarted: true };
      },
      // The new release never came up; launchd brought the old one back.
      checkHealth: async () => {
        healthCalls += 1;
        return healthCalls === 1 ? { ok: false, detail: "HTTP 502" } : { ok: true, detail: "HTTP 200" };
      },
    },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed, restartCommand: undefined }), deps);
    assert.equal(result.outcome, "rolled_back");
    assert.doesNotMatch(result.error, /Manual recovery/);
    assert.equal(state.current, PREV_DIR);
    const names = result.checks.map((c) => `${c.name}:${c.status}`);
    assert.ok(names.includes("rollback_restart:failed"));
    assert.ok(names.includes("rollback_health:passed"));
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("ROLLBACK: the default restart is told a crashed job is acceptable during rollback", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  const calls = [];
  let healthCalls = 0;
  const { deps } = harness({
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      restartService: (args) => {
        calls.push(args.allowNothingRunning);
        return args.allowNothingRunning ? { restarted: false, detail: "left to launchd" } : { restarted: true };
      },
      checkHealth: async () => {
        healthCalls += 1;
        return healthCalls === 1 ? { ok: false, detail: "HTTP 502" } : { ok: true, detail: "HTTP 200" };
      },
    },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed, restartCommand: undefined }), deps);
    assert.deepEqual(calls, [false, true]);
    assert.equal(result.outcome, "rolled_back");
    assert.equal(result.checks.find((c) => c.name === "rollback_restart").status, "skipped");
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

// ---------------------------------------------------------------------------
// A directory left by an earlier run (#833.6)
// ---------------------------------------------------------------------------
//
// Materializing seals a release read-only. When a later step failed, the next
// apply of the same tag reused the directory and built into sealed files: `tsc`
// failed with EACCES and nothing could proceed until someone removed it by hand.
// These run the real export, seal, marker and removal against temp dirs.

/** A repo with one tagged commit carrying a migration journal. */
function makeReleaseRepo() {
  const dir = tempRoot("ota-apply-repo-");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env });
  writeJournal(dir, ["0001_a"]);
  mkdirSync(path.join(dir, "server"), { recursive: true });
  writeFileSync(path.join(dir, "server", "index.js"), "console.log('v1');\n");
  git("add", ".");
  git("commit", "-qm", "release");
  git("tag", "v2026.827.2");
  return { dir, commit: git("rev-parse", "HEAD") };
}

/** A build that, like tsc, overwrites its previous output. */
function fakeBuild({ releaseDir }) {
  mkdirSync(path.join(releaseDir, "server", "dist"), { recursive: true });
  writeFileSync(path.join(releaseDir, "server", "dist", "index.js"), "built\n");
}

function diskFixture() {
  const repo = makeReleaseRepo();
  const releasesRoot = tempRoot("ota-apply-releases-");
  const installed = tempRoot("ota-installed-");
  writeJournal(installed, ["0001_a"]);
  const previous = path.join(releasesRoot, "v2026.827.1-e912d614");
  mkdirSync(previous, { recursive: true });
  realSwapCurrent({ releasesRoot, releaseDir: previous });
  const releaseDir = path.join(releasesRoot, `v2026.827.2-${repo.commit.slice(0, 8)}`);
  const exportArgs = { repoDir: repo.dir, tag: "v2026.827.2", commit: repo.commit, releasesRoot };
  /** What an earlier run left: exported, built and sealed — with or without the marker. */
  const leaveBehind = ({ completed }) => {
    realExportRelease(exportArgs);
    fakeBuild({ releaseDir });
    realSealRelease(releaseDir);
    if (completed) realWriteReleaseMarker(releaseDir, { tag: "v2026.827.2", commit: repo.commit });
  };
  const h = harness({
    deps: {
      resolveTagCommit: realResolveTagCommit,
      exportRelease: realExportRelease,
      buildRelease: fakeBuild,
      sealRelease: realSealRelease,
      writeReleaseMarker: realWriteReleaseMarker,
      readReleaseMarker: realReadReleaseMarker,
      removeRelease: realRemoveReleaseDir,
      readCurrent: realReadCurrent,
      swapCurrent: realSwapCurrent,
    },
  });
  const input = (stateDir, extra = {}) =>
    baseInput(stateDir, { repoDir: repo.dir, releasesRoot, installedRoot: installed, ...extra });
  const cleanup = () => {
    for (const dir of [repo.dir, releasesRoot, installed]) {
      realRemoveReleaseDir(dir);
    }
  };
  return { ...h, repo, releasesRoot, releaseDir, previous, leaveBehind, input, cleanup };
}

test("a first apply writes the completion marker after sealing", async () => {
  const f = diskFixture();
  const stateDir = tempRoot("ota-state-");
  try {
    const result = await runApply(f.input(stateDir), f.deps);
    assert.equal(result.outcome, "applied");
    assert.equal(isCompletedRelease(f.releaseDir, f.repo.commit), true);
    assert.match(result.checks.find((c) => c.name === "materialize").detail, /completion marker written/);
  } finally {
    f.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a rerun on a sealed, completed directory skips the build", async () => {
  const f = diskFixture();
  const stateDir = tempRoot("ota-state-");
  try {
    f.leaveBehind({ completed: true });
    const result = await runApply(f.input(stateDir), f.deps);
    assert.equal(result.outcome, "applied");
    assert.equal(realReadCurrent(f.releasesRoot), f.releaseDir);
    assert.deepEqual(f.order, ["export", "backup", `swap:${f.releaseDir}`, "restart", "prune"]);
    assert.equal(result.checks.find((c) => c.name === "reuse").status, "passed");
  } finally {
    f.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a rerun on a sealed but incomplete directory removes it and rebuilds", async () => {
  const f = diskFixture();
  const stateDir = tempRoot("ota-state-");
  try {
    f.leaveBehind({ completed: false });
    // The failure this replaces: building into the leftover hits a sealed file.
    assert.throws(() => fakeBuild({ releaseDir: f.releaseDir }), /EACCES|permission denied/i);

    const result = await runApply(f.input(stateDir), f.deps);
    assert.equal(result.outcome, "applied", result.error ?? "");
    assert.deepEqual(f.order, [
      "export",
      `remove:${f.releaseDir}`,
      "export",
      "backup",
      "build",
      "seal",
      "marker",
      `swap:${f.releaseDir}`,
      "restart",
      "prune",
    ]);
    assert.equal(isCompletedRelease(f.releaseDir, f.repo.commit), true);
    assert.match(result.checks.find((c) => c.name === "reuse").detail, /removed and re-exported/);
  } finally {
    f.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an incomplete directory that is the current release is never removed", async () => {
  const f = diskFixture();
  const stateDir = tempRoot("ota-state-");
  try {
    f.leaveBehind({ completed: false });
    realSwapCurrent({ releasesRoot: f.releasesRoot, releaseDir: f.releaseDir });
    const result = await runApply(f.input(stateDir, { force: true }), f.deps);
    assert.equal(result.outcome, "failed");
    assert.equal(result.failedStage, "materialize");
    assert.match(result.error, /current or previous/);
    assert.deepEqual(f.order, ["export"], "no removal, no backup, no switch");
    assert.ok(existsSync(path.join(f.releaseDir, "server", "index.js")));
  } finally {
    f.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an incomplete directory recorded as the previous release is never removed", async () => {
  const f = diskFixture();
  const stateDir = tempRoot("ota-state-");
  try {
    f.leaveBehind({ completed: false });
    writeFileSync(
      path.join(stateDir, "deployment-state.json"),
      JSON.stringify({ current: { commit: null, releaseDir: f.previous }, previous: { releaseDir: f.releaseDir } }),
    );
    const result = await runApply(f.input(stateDir), f.deps);
    assert.equal(result.failedStage, "materialize");
    assert.ok(existsSync(f.releaseDir));
  } finally {
    f.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("dry run reports an incomplete leftover directory without removing it", async () => {
  const f = diskFixture();
  const stateDir = tempRoot("ota-state-");
  try {
    f.leaveBehind({ completed: false });
    const result = await runApply(f.input(stateDir, { dryRun: true }), f.deps);
    assert.equal(result.outcome, "noop");
    assert.deepEqual(f.order, ["export"]);
    assert.ok(existsSync(path.join(f.releaseDir, "server", "dist", "index.js")));
    assert.match(result.checks.find((c) => c.name === "reuse").detail, /a real run removes and re-exports it/);
  } finally {
    f.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// After a healthy apply: prune (#833.2) and refresh the daily job's tools (#833.1)
// ---------------------------------------------------------------------------

test("a healthy apply prunes old releases, protecting current and previous, and records it", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  let pruneArgs;
  const { deps } = harness({
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      releasesInUse: () => ["v2026.820.0-aaaaaaaa"],
      releasesInPlists: (root, dirs) => (dirs.length > 0 ? ["v2026.821.0-bbbbbbbb"] : []),
      pruneReleases: (args) => {
        pruneArgs = args;
        return { planned: ["v2026.801.0-cccccccc"], removed: ["v2026.801.0-cccccccc"], held: false };
      },
    },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(
      baseInput(stateDir, { installedRoot: installed, keepReleases: 3, launchdPlistDirs: ["/plists"] }),
      deps,
    );
    assert.equal(result.outcome, "applied");
    assert.equal(pruneArgs.keep, 3);
    assert.deepEqual(pruneArgs.protectedNames, [path.basename(target), path.basename(PREV_DIR)]);
    // In use by a process, and configured in an installed launchd job (the backup's path).
    assert.deepEqual(pruneArgs.inUseNames, ["v2026.820.0-aaaaaaaa", "v2026.821.0-bbbbbbbb"]);
    assert.equal(pruneArgs.includeUntagged, false, "untagged directories only with --prune-untagged");
    assert.equal(pruneArgs.confirmed, false);
    const check = result.checks.find((c) => c.name === "prune");
    assert.equal(check.status, "passed");
    assert.match(check.detail, /removed v2026\.801\.0-cccccccc/);
    assert.match(check.detail, /in use or configured \(v2026\.820\.0-aaaaaaaa, v2026\.821\.0-bbbbbbbb\)/);
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("a failed prune or tool install does not turn a healthy apply into a failure", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  const { deps } = harness({
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      pruneReleases: () => {
        throw new Error("disk says no");
      },
      installUpdaterTools: () => {
        throw new Error("bin not writable");
      },
    },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed, binDir: "/bin-dir" }), deps);
    assert.equal(result.outcome, "applied");
    assert.equal(result.error, null);
    const names = result.checks.map((c) => `${c.name}:${c.status}`);
    assert.ok(names.includes("prune:failed"));
    assert.ok(names.includes("install_updater:failed"));
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("a rolled-back apply neither prunes nor replaces the updater tools", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  let healthCalls = 0;
  const { deps, order } = harness({
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      checkHealth: async () => {
        healthCalls += 1;
        return healthCalls === 1 ? { ok: false, detail: "HTTP 500" } : { ok: true, detail: "HTTP 200" };
      },
    },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed, binDir: "/bin-dir" }), deps);
    assert.equal(result.outcome, "rolled_back");
    assert.ok(!order.includes("prune"));
    assert.ok(!order.includes("install_updater"));
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("a healthy apply installs the release's updater tools into the bin dir", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  let installArgs;
  const { deps, order } = harness({
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      installUpdaterTools: (args) => {
        installArgs = args;
        return { binDir: args.binDir, installed: ["agentdash-update.sh", "ota-apply.mjs", "ota-release-layout.mjs"] };
      },
    },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed, binDir: "/bin-dir" }), deps);
    assert.equal(result.outcome, "applied");
    assert.deepEqual(installArgs, { releaseDir: target, binDir: "/bin-dir" });
    assert.deepEqual(order.slice(-3), ["restart", "install_updater", "prune"]);
    assert.equal(result.checks.find((c) => c.name === "install_updater").status, "passed");
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

function seedToolRelease() {
  const releaseDir = tempRoot("ota-tools-release-");
  for (const file of UPDATER_TOOL_FILES) {
    mkdirSync(path.join(releaseDir, path.dirname(file.from)), { recursive: true });
    writeFileSync(path.join(releaseDir, file.from), `new ${file.to}\n`);
  }
  realSealRelease(releaseDir);
  return releaseDir;
}

test("installUpdaterTools replaces the stale copies with the release's, executable and writable", () => {
  const releaseDir = seedToolRelease();
  const binDir = tempRoot("ota-bin-");
  try {
    writeFileSync(path.join(binDir, "ota-apply.mjs"), "stale\n");
    writeFileSync(path.join(binDir, "restart-server.sh"), "operator's own\n");
    const result = installUpdaterTools({ releaseDir, binDir });
    assert.deepEqual(result.installed, ["agentdash-update.sh", "ota-apply.mjs", "ota-release-layout.mjs"]);
    for (const file of UPDATER_TOOL_FILES) {
      assert.equal(readFileSync(path.join(binDir, file.to), "utf8"), `new ${file.to}\n`);
      assert.equal(statSync(path.join(binDir, file.to)).mode & 0o777, 0o755);
    }
    assert.equal(readFileSync(path.join(binDir, "restart-server.sh"), "utf8"), "operator's own\n", "other files untouched");
    assert.deepEqual(readdirSync(binDir).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    realRemoveReleaseDir(releaseDir);
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("installUpdaterTools installs nothing when the release lacks one of the files", () => {
  const releaseDir = seedToolRelease();
  const binDir = tempRoot("ota-bin-");
  try {
    chmodSync(path.join(releaseDir, "scripts", "deploy"), 0o755);
    rmSync(path.join(releaseDir, "scripts", "deploy", "ota-release-layout.mjs"), { force: true });
    writeFileSync(path.join(binDir, "ota-apply.mjs"), "stale\n");
    assert.throws(() => installUpdaterTools({ releaseDir, binDir }), /ota-release-layout\.mjs/);
    assert.equal(readFileSync(path.join(binDir, "ota-apply.mjs"), "utf8"), "stale\n", "a mismatched pair is worse than a stale one");
    assert.deepEqual(readdirSync(binDir), ["ota-apply.mjs"]);
  } finally {
    realRemoveReleaseDir(releaseDir);
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("prune fails safe: when what is in use cannot be determined, nothing is pruned", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  const { deps, order } = harness({
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      releasesInUse: () => {
        throw new Error("ps failed (exit 1); cannot tell which releases are in use");
      },
    },
  });
  const stateDir = approvedStateDir();
  try {
    const result = await runApply(baseInput(stateDir, { installedRoot: installed }), deps);
    assert.equal(result.outcome, "applied");
    assert.ok(!order.includes("prune"), "pruneReleases never called");
    const check = result.checks.find((c) => c.name === "prune");
    assert.equal(check.status, "failed");
    assert.match(check.detail, /nothing was pruned: ps failed/);
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("a large prune is held and listed in the receipt unless --prune-confirm", async () => {
  const installed = tempRoot("ota-installed-");
  const target = tempRoot("ota-target-");
  writeJournal(installed, ["0001_a"]);
  writeJournal(target, ["0001_a"]);
  const planned = ["a", "b", "c", "d", "e", "f"].map((x) => `v2026.80${"abcdef".indexOf(x)}.0-${x.repeat(8)}`);
  const confirmations = [];
  const { deps } = harness({
    deps: {
      exportRelease: () => ({ releaseDir: target, stagingDir: `${target}.s`, reused: false }),
      pruneReleases: (args) => {
        confirmations.push(args.confirmed);
        return args.confirmed ? { planned, removed: planned, held: false } : { planned, removed: [], held: true };
      },
    },
  });
  const stateDir = approvedStateDir();
  try {
    const held = await runApply(baseInput(stateDir, { installedRoot: installed }), deps);
    assert.equal(held.outcome, "applied");
    const check = held.checks.find((c) => c.name === "prune");
    assert.equal(check.status, "skipped");
    assert.match(check.detail, /held: 6 directories would be removed/);
    assert.match(check.detail, new RegExp(planned[5].replace(/\./g, "\\.")));
    assert.match(check.detail, /--prune --prune-confirm/);

    const confirmed = await runApply(baseInput(stateDir, { installedRoot: installed, pruneConfirm: true }), deps);
    assert.equal(confirmed.checks.find((c) => c.name === "prune").status, "passed");
    assert.deepEqual(confirmations, [false, true]);
  } finally {
    [installed, target, stateDir].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("an incomplete leftover directory that a running process uses is never removed", async () => {
  const f = diskFixture();
  const stateDir = tempRoot("ota-state-");
  try {
    f.leaveBehind({ completed: false });
    f.deps.releasesInUse = () => [path.basename(f.releaseDir)];
    const result = await runApply(f.input(stateDir), f.deps);
    assert.equal(result.failedStage, "materialize");
    assert.match(result.error, /running process still uses it/);
    assert.ok(existsSync(f.releaseDir));

    f.deps.releasesInUse = () => {
      throw new Error("lsof failed");
    };
    const blind = await runApply(f.input(stateDir), f.deps);
    assert.equal(blind.failedStage, "materialize");
    assert.match(blind.error, /cannot be checked/);
    assert.ok(existsSync(f.releaseDir));
  } finally {
    f.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("installUpdaterTools puts the old set back when a rename fails part-way", () => {
  const releaseDir = seedToolRelease();
  const binDir = tempRoot("ota-bin-");
  try {
    for (const file of UPDATER_TOOL_FILES) writeFileSync(path.join(binDir, file.to), `old ${file.to}\n`);
    // Block the third file's backup rename with a non-empty directory in its way.
    mkdirSync(path.join(binDir, `ota-release-layout.mjs.${process.pid}.prev`, "x"), { recursive: true });
    assert.throws(() => installUpdaterTools({ releaseDir, binDir }));
    for (const file of UPDATER_TOOL_FILES) {
      assert.equal(readFileSync(path.join(binDir, file.to), "utf8"), `old ${file.to}\n`, `${file.to} restored`);
    }
    assert.deepEqual(readdirSync(binDir).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    realRemoveReleaseDir(releaseDir);
    rmSync(binDir, { recursive: true, force: true });
  }
});
