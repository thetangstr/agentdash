#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const tscCliPath = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
const lockDir = path.join(rootDir, "node_modules", ".cache", "paperclip-plugin-build-deps.lock");
const lockTimeoutMs = 60_000;
const lockPollMs = 100;

const buildTargets = [
  {
    name: "@paperclipai/shared",
    output: path.join(rootDir, "packages/shared/dist/index.js"),
    tsconfig: path.join(rootDir, "packages/shared/tsconfig.json"),
    src: path.join(rootDir, "packages/shared/src"),
  },
  {
    name: "@paperclipai/plugin-sdk",
    output: path.join(rootDir, "packages/plugins/sdk/dist/index.js"),
    tsconfig: path.join(rootDir, "packages/plugins/sdk/tsconfig.json"),
    src: path.join(rootDir, "packages/plugins/sdk/src"),
  },
];

if (!fs.existsSync(tscCliPath)) {
  throw new Error(`TypeScript CLI not found at ${tscCliPath}`);
}

/**
 * Newest mtime under a source tree, or 0 if it cannot be read.
 *
 * Cheap by design: this runs before every typecheck and every test invocation,
 * so it walks .ts files and nothing else.
 */
function newestSourceMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      try {
        const mtime = fs.statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        // A file that vanished mid-walk cannot make the build newer.
      }
    }
  }
  return newest;
}

/**
 * A target is up to date only if its output exists AND is newer than every
 * source file that produced it.
 *
 * This used to check existence alone, which meant that once `dist/index.js`
 * existed it was never rebuilt again — no matter how far the source had moved
 * on. The consequence is not a build annoyance, it is a correctness one: the
 * server suite imports `@paperclipai/plugin-sdk` through its `exports` map,
 * which points at `dist`. So an edit to SDK source was INVISIBLE to both
 * `pnpm typecheck` and the tests.
 *
 * Found while trying to falsify the plugin capability gate: deleting the gate
 * from `host-client-factory.ts` broke no test, because the test was running
 * against a dist built before the deletion. A guard that cannot be falsified
 * is not known to work.
 */
function isUpToDate(target) {
  if (!fs.existsSync(target.output)) return false;
  if (!target.src) return true;
  let outputMtime;
  try {
    outputMtime = fs.statSync(target.output).mtimeMs;
  } catch {
    return false;
  }
  return newestSourceMtime(target.src) <= outputMtime;
}

function allOutputsExist() {
  return buildTargets.every(isUpToDate);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForLockRelease() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < lockTimeoutMs) {
    if (!fs.existsSync(lockDir)) {
      return;
    }
    if (allOutputsExist()) {
      return;
    }
    sleep(lockPollMs);
  }

  throw new Error(`Timed out waiting for plugin build dependency lock at ${lockDir}`);
}

if (allOutputsExist()) {
  process.exit(0);
}

fs.mkdirSync(path.dirname(lockDir), { recursive: true });

let holdsLock = false;
let exitCode = 0;
try {
  try {
    fs.mkdirSync(lockDir);
    holdsLock = true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      waitForLockRelease();
      if (!allOutputsExist()) {
        throw new Error("Plugin build dependency lock released before all outputs were created");
      }
      process.exit(0);
    }
    throw error;
  }

  for (const target of buildTargets) {
    if (isUpToDate(target)) {
      continue;
    }

    const result = spawnSync(process.execPath, [tscCliPath, "-p", target.tsconfig], {
      cwd: rootDir,
      stdio: "inherit",
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  if (holdsLock) {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

if (exitCode !== 0) {
  process.exit(exitCode);
}
