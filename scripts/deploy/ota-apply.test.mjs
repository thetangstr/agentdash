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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

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
    swapCurrent: (...args) => {
      order.push(`swap:${args[0].releaseDir}`);
      return merged.swapCurrent(...args);
    },
    runCommand: (cmd, label) => {
      order.push(label);
      return merged.runCommand(cmd, label);
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
    // Backup precedes build precedes switch precedes restart.
    assert.deepEqual(order, ["export", "backup", "build", "seal", `swap:${target}`, "restart"]);
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
