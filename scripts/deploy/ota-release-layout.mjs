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
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";

export const CURRENT_LINK_NAME = "current";
/** Releases kept on disk. Enough to roll back more than once, bounded so a small disk survives. */
export const DEFAULT_KEEP_RELEASES = 5;

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
 * Which releases may be deleted, given what must be kept.
 *
 * Pure so the retention rule can be tested without a disk. The currently linked
 * release and the rollback target are never candidates regardless of age — the
 * whole point of keeping releases is that rollback stays a symlink swap.
 */
export function planPrune({ releaseNames, keep = DEFAULT_KEEP_RELEASES, protectedNames = [] }) {
  const keepSet = new Set(protectedNames.filter(Boolean));
  const sorted = [...releaseNames].sort().reverse();
  const remove = [];
  let kept = 0;
  for (const name of sorted) {
    if (keepSet.has(name)) continue;
    if (kept < keep) {
      kept += 1;
      continue;
    }
    remove.push(name);
  }
  return remove;
}

export function pruneReleases({ releasesRoot, keep = DEFAULT_KEEP_RELEASES, protectedNames = [] }) {
  const root = path.resolve(releasesRoot);
  if (!existsSync(root)) return [];
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  const remove = planPrune({ releaseNames: names, keep, protectedNames });
  for (const name of remove) rmSync(path.join(root, name), { recursive: true, force: true });
  return remove;
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
  swapCurrent,
  readCurrent,
  planPrune,
  pruneReleases,
  resolveTagCommit,
};
