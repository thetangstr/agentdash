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
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";

import {
  CURRENT_LINK_NAME,
  DEFAULT_KEEP_RELEASES,
  RELEASE_MARKER_FILENAME,
  compareReleaseTags,
  exportRelease,
  isCompletedRelease,
  orderReleaseNames,
  planPrune,
  planReleaseLayout,
  pruneReleases,
  readCurrent,
  readReleaseMarker,
  releaseDirName,
  releaseNameForPath,
  releaseNamesInCommandLines,
  releasesInPlists,
  releasesInUse,
  releaseTagForDirName,
  removeReleaseDir,
  resolveTagCommit,
  sealRelease,
  swapCurrent,
  writeReleaseMarker,
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

// Release tags are vYYYY.MDD.N with a 3- or 4-digit MDD, so from October the
// string order is wrong: "v2026.1001.0" < "v2026.929.0". A string-sorted prune
// would keep old September releases and delete the new October ones.

test("compareReleaseTags orders by version, not by string", () => {
  assert.ok(compareReleaseTags("v2026.1001.0", "v2026.929.0") > 0);
  assert.ok(compareReleaseTags("v2026.901.10", "v2026.901.2") > 0);
  assert.equal(compareReleaseTags("v2026.929.0", "v2026.929.0"), 0);
  assert.ok("v2026.1001.0" < "v2026.929.0", "the string order this replaces really is wrong");
});

test("releaseTagForDirName reads the tag of a release directory and nothing else", () => {
  assert.equal(releaseTagForDirName("v2026.1001.0-bbbbbbbb"), "v2026.1001.0");
  assert.equal(releaseTagForDirName("candidate-main-12345678"), null);
  assert.equal(releaseTagForDirName("hotfix-2026.902.1-abcdef12"), null);
  assert.equal(releaseTagForDirName("main-12345678"), null);
});

test("planPrune keeps v2026.1001.0 over v2026.929.0", () => {
  const remove = planPrune({
    releaseNames: ["v2026.929.0-aaaaaaaa", "v2026.1001.0-bbbbbbbb", "v2026.1002.0-cccccccc"],
    keep: 2,
  });
  assert.deepEqual(remove, ["v2026.929.0-aaaaaaaa"]);
});

test("planPrune always keeps current and previous, and keeps N more besides", () => {
  const names = [
    "v2026.920.0-aaaaaaaa",
    "v2026.923.0-bbbbbbbb",
    "v2026.927.0-cccccccc",
    "v2026.929.0-dddddddd",
    "v2026.1001.0-eeeeeeee",
  ];
  const remove = planPrune({
    releaseNames: names,
    keep: 1,
    // Current is the newest; previous is deliberately an old one.
    protectedNames: ["v2026.1001.0-eeeeeeee", "v2026.920.0-aaaaaaaa"],
  });
  assert.deepEqual(remove, ["v2026.927.0-cccccccc", "v2026.923.0-bbbbbbbb"]);
});

test("planPrune never touches untagged directories unless asked, and then removes them first, oldest first", () => {
  const names = [
    "candidate-main-11111111",
    "v2026.927.0-cccccccc",
    "hotfix-2026.902.1-abcdef12",
    "v2026.929.0-dddddddd",
    "candidate-main-22222222",
  ];
  const mtimes = {
    "candidate-main-11111111": 1_000,
    "hotfix-2026.902.1-abcdef12": 2_000,
    "candidate-main-22222222": 3_000,
  };
  assert.deepEqual(orderReleaseNames(names, mtimes), [
    "v2026.929.0-dddddddd",
    "v2026.927.0-cccccccc",
    "candidate-main-22222222",
    "hotfix-2026.902.1-abcdef12",
    "candidate-main-11111111",
  ]);
  // A hotfix directory may be the only built copy of something; by default it stays.
  assert.deepEqual(planPrune({ releaseNames: names, keep: 1, mtimes }), ["v2026.927.0-cccccccc"]);
  assert.deepEqual(planPrune({ releaseNames: names, keep: 3, mtimes, includeUntagged: true }), [
    "hotfix-2026.902.1-abcdef12",
    "candidate-main-11111111",
  ]);
});

test("releaseNamesInCommandLines finds the releases running processes execute from", () => {
  const root = "/Users/x/.agentdash/releases";
  const names = releaseNamesInCommandLines(root, [
    `${root}/v2026.927.0-cccccccc/node_modules/.pnpm/@embedded-postgres+darwin-arm64/bin/postgres -D /db -p 54329`,
    `node ${root}/current/server/dist/index.js`,
    `/bin/zsh ${root}/.staging-v2026.1001.0-eeeeeeee/deploy/x.sh`,
    "/usr/sbin/cron",
  ]);
  // `current` and staging are not release names; the postgres release is.
  assert.deepEqual(names, ["v2026.927.0-cccccccc"]);
});

test("pruneReleases deletes sealed releases, keeping current, previous and anything in use", () => {
  const root = tempDir("ota-prune-");
  try {
    const names = [
      "candidate-main-11111111",
      "v2026.920.0-aaaaaaaa",
      "v2026.923.0-bbbbbbbb",
      "v2026.927.0-cccccccc",
      "v2026.929.0-dddddddd",
      "v2026.1001.0-eeeeeeee",
    ];
    for (const name of names) {
      mkdirSync(path.join(root, name, "server"), { recursive: true });
      writeFileSync(path.join(root, name, "server", "index.js"), "x\n");
      sealRelease(path.join(root, name));
    }
    swapCurrent({ releasesRoot: root, releaseDir: path.join(root, "v2026.1001.0-eeeeeeee") });
    const { removed, held } = pruneReleases({
      releasesRoot: root,
      keep: 1,
      protectedNames: ["v2026.1001.0-eeeeeeee", "v2026.929.0-dddddddd"],
      inUseNames: ["v2026.920.0-aaaaaaaa"],
      includeUntagged: true,
    });
    assert.equal(held, false);
    assert.deepEqual(removed.sort(), ["candidate-main-11111111", "v2026.923.0-bbbbbbbb"]);
    for (const name of removed) assert.equal(existsSync(path.join(root, name)), false);
    for (const name of ["v2026.1001.0-eeeeeeee", "v2026.929.0-dddddddd", "v2026.927.0-cccccccc", "v2026.920.0-aaaaaaaa"]) {
      assert.ok(existsSync(path.join(root, name)), `${name} must survive`);
    }
    assert.ok(lstatSync(path.join(root, CURRENT_LINK_NAME)).isSymbolicLink(), "current is never a candidate");
    assert.equal(readCurrent(root), path.join(root, "v2026.1001.0-eeeeeeee"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneReleases orders non-tag directories by their real mtime", () => {
  const root = tempDir("ota-prune-mtime-");
  try {
    for (const [name, seconds] of [["candidate-main-old", 1_000_000], ["candidate-main-new", 2_000_000]]) {
      mkdirSync(path.join(root, name));
      utimesSync(path.join(root, name), seconds, seconds);
    }
    assert.deepEqual(
      pruneReleases({ releasesRoot: root, keep: 1, inUseNames: [], includeUntagged: true }).removed,
      ["candidate-main-old"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneReleases holds a large first prune until confirmed, and says what it would remove", () => {
  const root = tempDir("ota-prune-hold-");
  try {
    const names = Array.from({ length: 9 }, (_, i) => `v2026.9${10 + i}.0-${String(i).repeat(8)}`);
    for (const name of names) mkdirSync(path.join(root, name));
    const held = pruneReleases({ releasesRoot: root, keep: 1, inUseNames: [], maxRemovals: 5 });
    assert.equal(held.held, true);
    assert.equal(held.planned.length, 8);
    assert.deepEqual(held.removed, []);
    for (const name of names) assert.ok(existsSync(path.join(root, name)), "nothing removed while held");

    const dry = pruneReleases({ releasesRoot: root, keep: 1, inUseNames: [], dryRun: true, confirmed: true });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.removed, []);

    const done = pruneReleases({ releasesRoot: root, keep: 1, inUseNames: [], maxRemovals: 5, confirmed: true });
    assert.equal(done.removed.length, 8);
    assert.ok(existsSync(path.join(root, "v2026.918.0-88888888")), "the newest tag is kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneReleases refuses to run without knowing what is in use", () => {
  assert.throws(() => pruneReleases({ releasesRoot: "/nonexistent" }), /in use/);
});

/** A spawnSync stand-in: `answers` maps a command name to its result. */
const fakeRun = (answers) => (command) => answers[command] ?? { status: 127, stdout: "" };

test("releasesInUse fails safe: a failed ps or lsof throws instead of reporting nothing in use", () => {
  const root = "/Users/x/.agentdash/releases";
  const lsofOk = { status: 0, stdout: "p1\nfcwd\nn/\n" };
  assert.throws(() => releasesInUse(root, fakeRun({ ps: { status: 1, stdout: "" }, lsof: lsofOk })), /ps failed/);
  assert.throws(() => releasesInUse(root, fakeRun({ ps: { error: new Error("ENOENT") }, lsof: lsofOk })), /ps failed/);
  assert.throws(() => releasesInUse(root, fakeRun({ ps: { status: 0, stdout: "" }, lsof: { status: 1, stdout: "" } })), /lsof failed/);
});

test("releasesInUse also protects a release held only as a working directory or mapped file", () => {
  const root = "/Users/x/.agentdash/releases";
  const names = releasesInUse(root, fakeRun({
    // pnpm's argv names no release; its cwd does.
    ps: { status: 0, stdout: "node /opt/homebrew/bin/pnpm exec tsx src/index.ts\n" },
    lsof: {
      status: 1, // some processes could not be inspected; the rest is still an answer
      stdout: [
        "p5001", "fcwd", `n${root}/v2026.929.0-dddddddd/server`,
        "p5100", "ftxt", `n${root}/v2026.927.0-cccccccc/node_modules/.pnpm/x/bin/postgres`,
        "p1", "fcwd", "n/",
      ].join("\n"),
    },
  }));
  assert.deepEqual(names.sort(), ["v2026.927.0-cccccccc", "v2026.929.0-dddddddd"]);
});

test("releasesInPlists protects releases an installed launchd job is configured to run from", () => {
  const dir = tempDir("ota-plists-");
  try {
    const root = "/Users/x/.agentdash/releases";
    writeFileSync(
      path.join(dir, "com.agentdash.mkboard.backup.plist"),
      `<array>\n<string>${root}/v2026.923.0-bbbbbbbb/deploy/agentdash-backup.sh</string>\n</array>\n`,
    );
    writeFileSync(path.join(dir, "com.agentdash.mkboard.server.plist"), `<string>${root}/current/deploy/agentdash-server.sh</string>\n`);
    writeFileSync(path.join(dir, "com.other.plist"), `<string>${root}/v2026.901.0-cccccccc/x</string>\n`);
    assert.deepEqual(releasesInPlists(root, [dir, path.join(dir, "missing")]), ["v2026.923.0-bbbbbbbb"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Completion marker and removal
// ---------------------------------------------------------------------------

test("a release is complete only with a marker for the same commit", () => {
  const dir = tempDir("ota-marker-");
  try {
    assert.equal(readReleaseMarker(dir), null);
    assert.equal(isCompletedRelease(dir, "c".repeat(40)), false);
    writeReleaseMarker(dir, { tag: "v2026.929.0", commit: "c".repeat(40), now: "2026-01-01T00:00:00.000Z" });
    assert.equal(isCompletedRelease(dir, "c".repeat(40)), true);
    assert.equal(isCompletedRelease(dir, "d".repeat(40)), false);
    assert.equal(readReleaseMarker(dir).completedAt, "2026-01-01T00:00:00.000Z");
    // Read-only like the rest of a sealed release, and rewritable all the same.
    assert.equal(statSync(path.join(dir, RELEASE_MARKER_FILENAME)).mode & 0o222, 0);
    writeReleaseMarker(dir, { tag: "v2026.929.0", commit: "d".repeat(40) });
    assert.equal(isCompletedRelease(dir, "d".repeat(40)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeReleaseDir removes a sealed tree, including a read-only directory inside it", () => {
  const root = tempDir("ota-remove-");
  const dir = path.join(root, "v2026.929.0-dddddddd");
  try {
    mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "x\n");
    mkdirSync(path.join(dir, "server"), { recursive: true });
    writeFileSync(path.join(dir, "server", "index.js"), "x\n");
    sealRelease(dir);
    chmodSync(path.join(dir, "node_modules", "pkg"), 0o555);
    removeReleaseDir(dir);
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------
//
// The executable case is the one that matters, and it had no test before.
//
// Sealing used to chmod every file to 0444, which removes +x. A release's own
// launcher is `deploy/agentdash-server.sh`, and launchd refuses a
// non-executable `ProgramArguments` — so sealing made every release unable to
// start, and the failure surfaced at cutover instead of at build time. `git
// archive` preserves mode 100755, so the +x present in an exported release is
// the one the commit recorded; sealing must only take away write.

function seedTreeForSealing() {
  const root = tempDir("ota-seal-");
  mkdirSync(path.join(root, "deploy"), { recursive: true });
  mkdirSync(path.join(root, "server", "src"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });

  writeFileSync(path.join(root, "deploy", "launcher.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(root, "deploy", "launcher.sh"), 0o755);

  writeFileSync(path.join(root, "server", "src", "index.ts"), "export {};\n");
  chmodSync(path.join(root, "server", "src", "index.ts"), 0o644);

  writeFileSync(path.join(root, "node_modules", ".bin", "tsx"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(root, "node_modules", ".bin", "tsx"), 0o755);

  return root;
}

const mode = (p) => statSync(p).mode & 0o777;

test("sealRelease keeps an executable file executable", () => {
  const root = seedTreeForSealing();
  try {
    sealRelease(root);
    const launcher = path.join(root, "deploy", "launcher.sh");
    assert.equal(mode(launcher), 0o555, "a launcher must stay executable or launchd cannot start it");
    assert.ok((statSync(launcher).mode & 0o111) !== 0);
    // Still read-only: sealing takes away write, nothing else.
    assert.equal(statSync(launcher).mode & 0o222, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sealRelease makes a plain file read-only and non-executable", () => {
  const root = seedTreeForSealing();
  try {
    sealRelease(root);
    const source = path.join(root, "server", "src", "index.ts");
    assert.equal(mode(source), 0o444);
    assert.equal(statSync(source).mode & 0o111, 0, "a source file must not gain +x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sealRelease leaves node_modules alone", () => {
  const root = seedTreeForSealing();
  try {
    sealRelease(root);
    // Some toolchains write in here at runtime, so it is deliberately skipped.
    assert.equal(mode(path.join(root, "node_modules", ".bin", "tsx")), 0o755);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sealRelease reports how much it sealed, and how much stayed executable", () => {
  const root = seedTreeForSealing();
  try {
    const result = sealRelease(root);
    assert.equal(result.sealed, 2, "two files outside node_modules");
    assert.equal(result.sealedExecutable, 1, "one of them was executable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sealRelease is idempotent", () => {
  const root = seedTreeForSealing();
  try {
    sealRelease(root);
    const first = mode(path.join(root, "deploy", "launcher.sh"));
    sealRelease(root);
    assert.equal(mode(path.join(root, "deploy", "launcher.sh")), first, "re-sealing must not degrade +x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
