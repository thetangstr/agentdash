#!/usr/bin/env node
// Immutable release directories for source-mode deployments.
//
// The problem this solves, concretely: on the MK Mini the server is started by
// launchd with its cwd inside `~/agentdash` — the same clone a developer works
// in. The process serves whatever files are on disk, so `git checkout` changes
// production at the next restart, and the updater's own `git checkout --detach`
// silently discards whatever branch someone was on. Both directions are silent
// and both have happened.
//
// A release therefore becomes a directory, not a ref:
//
//   <releasesRoot>/v2026.827.2-4637abd7/    exported, built, then made read-only
//   <releasesRoot>/current -> v2026.827.2-4637abd7
//
// The export uses `git archive`, which writes no `.git`. That is the point:
// there is nothing in a release directory for `git checkout` to act on, so the
// developer tree and the serving tree cannot be confused again. Rollback is a
// symlink swap back to a directory that was never mutated.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const CURRENT_LINK_NAME = "current";
/** Releases kept on disk. Enough to roll back more than once, bounded so a small disk survives. */
export const DEFAULT_KEEP_RELEASES = 5;
/**
 * More removals than this in one prune are held, not performed, unless the
 * operator confirms. The first prune on a box that has never pruned could
 * otherwise delete dozens of directories nobody reviewed.
 */
export const PRUNE_CONFIRM_THRESHOLD = 5;
/**
 * Written into a release directory as the LAST step of materializing it —
 * after the build and after sealing. Its presence, for the same commit, is the
 * only evidence that a directory left behind by an earlier run is a finished
 * release rather than a half-built one.
 */
export const RELEASE_MARKER_FILENAME = ".agentdash-release.json";

/**
 * Directory name for a release. Tag plus short commit, because a tag can be
 * moved upstream and the commit is what actually shipped.
 */
export function releaseDirName(tag, commit) {
  if (!tag) throw new Error("A release directory needs a tag.");
  if (!commit || commit.length < 7) throw new Error("A release directory needs a full commit sha.");
  return `${tag}-${commit.slice(0, 8)}`;
}

/** Paths involved in installing one release. Pure — computes, touches nothing. */
export function planReleaseLayout({ releasesRoot, tag, commit }) {
  const root = path.resolve(releasesRoot);
  const name = releaseDirName(tag, commit);
  return {
    releasesRoot: root,
    releaseName: name,
    releaseDir: path.join(root, name),
    stagingDir: path.join(root, `.staging-${name}`),
    currentLink: path.join(root, CURRENT_LINK_NAME),
  };
}

/**
 * Which release a path belongs to, or null.
 *
 * Used to answer "is the running process serving from a release directory?".
 * Resolves through the `current` symlink so a process started via `current`
 * still reports the concrete release it landed on.
 */
export function releaseNameForPath(releasesRoot, candidatePath) {
  if (!candidatePath) return null;
  const root = path.resolve(releasesRoot);
  const resolved = path.resolve(candidatePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) return null;
  const rest = resolved.slice(root.length + 1);
  const first = rest.split(path.sep)[0];
  if (!first || first === CURRENT_LINK_NAME || first.startsWith(".staging-")) return null;
  return first;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}: ${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

/**
 * Export a commit into a fresh directory, with no `.git`.
 *
 * Staged under a dotted sibling and renamed into place only once the export
 * succeeds, so an interrupted run never leaves a half-populated directory that
 * looks like a valid release.
 */
export function exportRelease({ repoDir, tag, commit, releasesRoot }) {
  const layout = planReleaseLayout({ releasesRoot, tag, commit });
  if (existsSync(layout.releaseDir)) return { ...layout, reused: true };

  rmSync(layout.stagingDir, { recursive: true, force: true });
  mkdirSync(layout.stagingDir, { recursive: true });

  // `git archive | tar -x` rather than a worktree: a worktree carries a .git
  // file and can be checked out, which is exactly what must be impossible here.
  const archive = spawnSync("git", ["-C", repoDir, "archive", "--format=tar", commit], {
    maxBuffer: 1024 * 1024 * 1024,
    encoding: "buffer",
  });
  if (archive.status !== 0) {
    rmSync(layout.stagingDir, { recursive: true, force: true });
    throw new Error(`git archive ${commit} failed: ${archive.stderr?.toString() ?? ""}`);
  }
  const extract = spawnSync("tar", ["-x", "-C", layout.stagingDir], { input: archive.stdout });
  if (extract.status !== 0) {
    rmSync(layout.stagingDir, { recursive: true, force: true });
    throw new Error(`tar extract failed: ${extract.stderr?.toString() ?? ""}`);
  }

  renameSync(layout.stagingDir, layout.releaseDir);
  return { ...layout, reused: false };
}

/**
 * Install dependencies and build inside a release directory.
 *
 * `--frozen-lockfile` is not optional here. The alternative resolves fresh from
 * the public registry on the customer's machine at apply time, which turns
 * every update into an unreviewed dependency fetch. That is a live supply-chain
 * path, not a hypothetical one, and a release that cannot install frozen is a
 * release that is not ready to ship.
 */
export function buildRelease({ releaseDir, env = process.env }) {
  run("pnpm", ["install", "--frozen-lockfile", "--config.confirm-modules-purge=false"], {
    cwd: releaseDir,
    env: { ...env, CI: "1" },
  });
  run("pnpm", ["--filter", "./packages/**", "build"], { cwd: releaseDir, env });
  run("pnpm", ["--filter", "@paperclipai/ui", "build"], { cwd: releaseDir, env });
}

/**
 * Make a built release read-only.
 *
 * Best-effort and deliberately non-fatal: this is a guard rail against
 * accidental edits, not a security boundary — the owner can always chmod back.
 * `node_modules` is skipped because some toolchains write into it at runtime
 * and a read-only tree there causes failures that look like bugs in the app.
 */
export function sealRelease(releaseDir) {
  const skip = new Set(["node_modules", ".pnpm-store"]);
  let sealed = 0;
  let sealedExecutable = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          // Read-only, but KEEP the executable bit.
          //
          // This chmodded everything to 0444, which silently removed +x. The
          // release's own launcher is `deploy/agentdash-server.sh`, and launchd
          // requires an executable `ProgramArguments` — so sealing made every
          // release unable to start, and the failure appeared at cutover rather
          // than at build time. Caught on the first real bundle, before it was
          // switched to.
          //
          // `git archive` preserves mode 100755, so the +x bit present here is
          // the one the release commit recorded; this only takes away write.
          const executable = (statSync(full).mode & 0o111) !== 0;
          chmodSync(full, executable ? 0o555 : 0o444);
          sealed += 1;
          if (executable) sealedExecutable += 1;
        } catch {
          // Non-fatal by design; see above.
        }
      }
    }
  };
  walk(releaseDir);
  return { sealed, sealedExecutable };
}

/**
 * Record that a release directory is complete: exported, built and sealed.
 *
 * Why this exists: the export makes the directory, the build fills it, and
 * sealing makes its files read-only. When an apply failed after that point
 * (at the restart, say), the next apply of the same tag found the directory,
 * took it as reusable, and ran the build into files that sealing had made
 * 0444. The build failed, and the update could not proceed until someone
 * removed the directory by hand. The marker lets a rerun tell "finished,
 * reuse it" from "left half-built, start again".
 */
export function writeReleaseMarker(releaseDir, { tag, commit, now = new Date().toISOString() }) {
  const markerPath = path.join(releaseDir, RELEASE_MARKER_FILENAME);
  // A previous marker is read-only; the directory is not, so unlinking works.
  rmSync(markerPath, { force: true });
  writeFileSync(
    markerPath,
    `${JSON.stringify({ schemaVersion: 1, tag, commit, complete: true, completedAt: now }, null, 2)}\n`,
    { mode: 0o444 },
  );
  return markerPath;
}

/** The completion marker of a release directory, or null when absent or unreadable. */
export function readReleaseMarker(releaseDir) {
  try {
    const marker = JSON.parse(readFileSync(path.join(releaseDir, RELEASE_MARKER_FILENAME), "utf8"));
    return marker && typeof marker === "object" ? marker : null;
  } catch {
    return null;
  }
}

/** Is this directory a finished release of exactly this commit? */
export function isCompletedRelease(releaseDir, commit) {
  const marker = readReleaseMarker(releaseDir);
  return Boolean(marker && marker.complete === true && marker.commit === commit);
}

function makeTreeWritable(dir) {
  try {
    chmodSync(dir, (lstatSync(dir).mode & 0o7777) | 0o700);
  } catch {
    return;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Dirent types come from lstat, so a symlink is never followed out of the tree.
    if (entry.isDirectory()) makeTreeWritable(path.join(dir, entry.name));
  }
}

/**
 * Delete a release directory, sealed or not.
 *
 * Sealing only takes write away from files, and a file in a writable directory
 * can be unlinked, so a plain recursive remove normally works. A read-only
 * directory somewhere in the tree (some packages ship them) does not allow
 * that, so on a permission error the tree's directories are made writable and
 * the remove is tried once more.
 */
export function removeReleaseDir(releaseDir) {
  try {
    rmSync(releaseDir, { recursive: true, force: true });
  } catch (error) {
    // Node reports a read-only subdirectory as ENOTEMPTY on the way back up.
    if (!["EACCES", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
    makeTreeWritable(releaseDir);
    rmSync(releaseDir, { recursive: true, force: true });
  }
}

/**
 * Point `current` at a release atomically.
 *
 * A symlink cannot be replaced in place, so this writes a temporary link beside
 * it and renames over — `rename(2)` is atomic, meaning no observer ever sees
 * `current` missing. A restart racing this swap sees the old release or the new
 * one, never neither.
 */
export function swapCurrent({ releasesRoot, releaseDir }) {
  const root = path.resolve(releasesRoot);
  const link = path.join(root, CURRENT_LINK_NAME);
  const previous = readCurrent(releasesRoot);
  const temp = path.join(root, `.current-${process.pid}-${Date.now()}`);

  mkdirSync(root, { recursive: true });
  symlinkSync(path.resolve(releaseDir), temp);
  renameSync(temp, link);
  return { link, previous, now: path.resolve(releaseDir) };
}

/** Where `current` points, or null when it is absent. */
export function readCurrent(releasesRoot) {
  const link = path.join(path.resolve(releasesRoot), CURRENT_LINK_NAME);
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    return path.resolve(path.dirname(link), readlinkSync(link));
  } catch {
    return null;
  }
}

/**
 * Compare release tags by version, not by name: v2026.1001.0 > v2026.929.0,
 * and v2026.901.10 > v2026.901.2. A plain string sort gets both wrong.
 */
export function compareReleaseTags(a, b) {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const RELEASE_DIR_PATTERN = /^(v\d{4}\.\d{3,4}\.\d+)-[0-9a-f]{7,40}$/;

/** The release tag a directory name was made from, or null for anything else. */
export function releaseTagForDirName(name) {
  const match = RELEASE_DIR_PATTERN.exec(name ?? "");
  return match && isReleaseTag(match[1]) ? match[1] : null;
}

/**
 * Release directory names, newest first.
 *
 * Directories made from a release tag come first, ordered by version. Anything
 * else — `candidate-main-*`, `hotfix-*`, hand-made directories — follows,
 * ordered by modification time. Those are not releases the apply path can
 * produce or roll back to by tag, so under a keep limit they go first.
 */
export function orderReleaseNames(releaseNames, mtimes = {}) {
  const mtime = (name) => Number(mtimes[name] ?? 0);
  const tagged = [];
  const other = [];
  for (const name of releaseNames) (releaseTagForDirName(name) ? tagged : other).push(name);
  tagged.sort((a, b) =>
    compareReleaseTags(releaseTagForDirName(b), releaseTagForDirName(a)) || mtime(b) - mtime(a) || b.localeCompare(a));
  other.sort((a, b) => mtime(b) - mtime(a) || b.localeCompare(a));
  return [...tagged, ...other];
}

/**
 * Which releases may be deleted, given what must be kept.
 *
 * Pure so the retention rule can be tested without a disk. The currently linked
 * release and the rollback target are never candidates regardless of age — the
 * whole point of keeping releases is that rollback stays a symlink swap. `keep`
 * counts the releases kept IN ADDITION to the protected ones.
 *
 * Only directories made from a release tag are candidates by default.
 * `candidate-*`, `hotfix-*` and hand-made directories may be the only built
 * copy of something, and nothing about their name says whether it is safe to
 * lose, so they are pruned only with `includeUntagged` — and then first.
 */
export function planPrune({
  releaseNames,
  keep = DEFAULT_KEEP_RELEASES,
  protectedNames = [],
  mtimes = {},
  includeUntagged = false,
}) {
  const keepSet = new Set(protectedNames.filter(Boolean));
  const remove = [];
  let kept = 0;
  for (const name of orderReleaseNames(releaseNames, mtimes)) {
    if (keepSet.has(name)) continue;
    if (!includeUntagged && !releaseTagForDirName(name)) continue;
    if (kept < keep) {
      kept += 1;
      continue;
    }
    remove.push(name);
  }
  return remove;
}

/**
 * Release directories that a running process names on its command line.
 *
 * Anything that outlives an apply and runs from a release (an old server a
 * restart missed, a backup mid-run, a database started from a release binary)
 * would break when its directory is deleted under it — the next file it loads
 * is gone. So a release a live process names is never pruned, whatever its age.
 */
export function releaseNamesInCommandLines(releasesRoot, commandLines) {
  const roots = new Set([path.resolve(releasesRoot)]);
  try {
    roots.add(realpathSync(releasesRoot));
  } catch {
    // A root that does not exist has nothing running from it.
  }
  const names = new Set();
  for (const line of commandLines) {
    for (const root of roots) {
      const prefix = `${root}${path.sep}`;
      let at = line.indexOf(prefix);
      while (at !== -1) {
        const name = line.slice(at + prefix.length).split(/[\/\s]/)[0];
        if (name && name !== CURRENT_LINK_NAME && !name.startsWith(".")) names.add(name);
        at = line.indexOf(prefix, at + prefix.length);
      }
    }
  }
  return [...names];
}

/**
 * Releases that running processes use: named on a command line (`ps`), or
 * held as a working directory or an executable/mapped file (`lsof -d cwd,txt`).
 * The command line alone misses, for example, the pnpm wrapper of the server,
 * whose cwd is in a release and whose argv names none.
 *
 * THROWS when either tool cannot answer. The only safe reading of "could not
 * tell what is in use" is "prune nothing"; an empty list would mean "nothing
 * is in use" and delete a directory under a live process.
 *
 * `lsof` only sees this user's processes. The shipped LaunchDaemons run every
 * AgentDash service as one `UserName`, the same user the updater runs as.
 */
export function releasesInUse(releasesRoot, run = spawnSync) {
  const ps = run("ps", ["-axww", "-o", "command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (ps.error || ps.status !== 0) {
    throw new Error(`ps failed (${ps.error?.message ?? `exit ${ps.status}`}); cannot tell which releases are in use`);
  }
  const lsof = run("lsof", ["-nP", "-d", "cwd,txt", "-Fn"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
  // lsof exits non-zero when it could not inspect some process; its output for
  // the rest is still an answer. No output at all is not.
  if (lsof.error || (lsof.status !== 0 && !(lsof.stdout ?? "").trim())) {
    throw new Error(`lsof failed (${lsof.error?.message ?? `exit ${lsof.status}`}); cannot tell which releases are in use`);
  }
  const files = (lsof.stdout ?? "").split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  return [...new Set([
    ...releaseNamesInCommandLines(releasesRoot, (ps.stdout ?? "").split("\n")),
    ...releaseNamesInCommandLines(releasesRoot, files),
  ])];
}

/**
 * Releases that an installed launchd job is configured to run from — a
 * backup job pinned to a concrete release directory, say. Read from the
 * `com.agentdash.*` plists in the given directories. Throws on a plist that
 * exists but cannot be read, for the same reason `releasesInUse` does.
 */
export function releasesInPlists(releasesRoot, plistDirs = []) {
  const names = new Set();
  for (const dir of plistDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!/^com\.agentdash\..*\.plist$/.test(entry)) continue;
      const text = readFileSync(path.join(dir, entry), "utf8");
      for (const name of releaseNamesInCommandLines(releasesRoot, text.split("\n"))) names.add(name);
    }
  }
  return [...names];
}

/**
 * Delete releases beyond the keep limit.
 *
 * Only real directories are candidates: `current` is a symlink and is skipped
 * by type, and dot-prefixed staging and temp entries are skipped by name.
 * When more than `maxRemovals` would go at once and the operator has not
 * confirmed, nothing is deleted and the plan is returned as `held`, so a
 * receipt can show exactly what a confirmed prune would remove.
 */
export function pruneReleases({
  releasesRoot,
  keep = DEFAULT_KEEP_RELEASES,
  protectedNames = [],
  inUseNames,
  includeUntagged = false,
  maxRemovals = PRUNE_CONFIRM_THRESHOLD,
  confirmed = false,
  dryRun = false,
}) {
  if (!Array.isArray(inUseNames)) {
    throw new Error("pruneReleases needs the releases in use; refusing to prune without knowing them");
  }
  const root = path.resolve(releasesRoot);
  if (!existsSync(root)) return { planned: [], removed: [], held: false };
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  const mtimes = {};
  for (const name of names) {
    try {
      mtimes[name] = statSync(path.join(root, name)).mtimeMs;
    } catch {
      mtimes[name] = 0;
    }
  }
  const planned = planPrune({
    releaseNames: names,
    keep,
    protectedNames: [...protectedNames, ...inUseNames],
    mtimes,
    includeUntagged,
  });
  if (dryRun) return { planned, removed: [], held: false, dryRun: true };
  if (planned.length > maxRemovals && !confirmed) return { planned, removed: [], held: true };
  const removed = [];
  for (const name of planned) {
    removeReleaseDir(path.join(root, name));
    removed.push(name);
  }
  return { planned, removed, held: false };
}

/** Release tags are date-versioned: `v2026.827.2`. Must match the TS planner. */
const RELEASE_TAG_PATTERN = /^v\d{4}\.\d{3,4}\.\d+$/;

export function isReleaseTag(tag) {
  return RELEASE_TAG_PATTERN.test(tag ?? "");
}

/**
 * Is this the authoritative release source?
 *
 * Duplicated deliberately from `server/src/services/ota-release-plan.ts`. The
 * updater is standalone by design — it is the tool that repairs a broken deploy,
 * so it must not depend on the application's build output being intact. The two
 * copies are held together by a parity test
 * (`server/src/__tests__/ota-release-source-parity.test.ts`) that runs the same
 * case table through both and fails if they ever disagree.
 */
export function isAuthoritativeReleaseSource({ remote, branch, tag, commitOnBranch }) {
  if (remote !== "origin") {
    return { ok: false, reason: `Release source must be the 'origin' remote, got '${remote}'.` };
  }
  if (branch !== "main") {
    return { ok: false, reason: `Release source must be the 'main' branch, got '${branch}'.` };
  }
  if (!tag) {
    return { ok: false, reason: "Release source must be a release tag; a bare commit is not a release." };
  }
  if (!isReleaseTag(tag)) {
    return { ok: false, reason: `'${tag}' is not a release tag (expected vYYYY.MDD.N).` };
  }
  if (!commitOnBranch) {
    return { ok: false, reason: `Tag '${tag}' does not point at a commit on origin/main.` };
  }
  return { ok: true };
}

/** Throwing form, for the updater's pre-apply gate. */
export function assertAuthoritativeReleaseSource(input) {
  const verdict = isAuthoritativeReleaseSource(input);
  if (!verdict.ok) throw new Error(`Refusing to deploy: ${verdict.reason}`);
}

/** Resolve a release tag to its commit, refusing anything that is not a tag. */
export function resolveTagCommit(repoDir, tag) {
  return capture("git", ["-C", repoDir, "rev-list", "-n", "1", `refs/tags/${tag}`]);
}

export default {
  isReleaseTag,
  isAuthoritativeReleaseSource,
  assertAuthoritativeReleaseSource,
  releaseDirName,
  planReleaseLayout,
  releaseNameForPath,
  exportRelease,
  buildRelease,
  sealRelease,
  writeReleaseMarker,
  readReleaseMarker,
  isCompletedRelease,
  removeReleaseDir,
  swapCurrent,
  readCurrent,
  compareReleaseTags,
  releaseTagForDirName,
  orderReleaseNames,
  planPrune,
  releaseNamesInCommandLines,
  releasesInUse,
  releasesInPlists,
  pruneReleases,
  resolveTagCommit,
};
