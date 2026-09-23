// Entry-guard regression coverage (GH #666).
//
// `import.meta.url` is the resolved real path; `process.argv[1]` is the path as
// typed. An entry guard that compares them directly is false when the script is
// invoked through a symlink — and a false guard means the module loads, exports
// nothing observable, and exits 0. That is the worst possible failure mode for
// a deploy script: `releases/current` is a symlink, so the documented way to
// run ota-apply was the broken one, and launchd reported success for a run that
// did nothing.
//
// Two layers here:
//
//   1. Spawn the --help-supporting scripts through a symlinked path and assert
//      they actually ran (non-empty output). Before the fix every one of these
//      exited 0 with no output.
//   2. Audit every scripts/**/*.mjs entry point: any file that gates on both
//      process.argv[1] and import.meta.url must compare realpaths, so the
//      idiom cannot silently come back in a new script.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS_ROOT = path.join(REPO_ROOT, "scripts");

// Scripts whose --help (or -h) prints usage and exits 0 without side effects.
const HELP_SCRIPTS = [
  "deploy/ota-apply.mjs",
  "deploy/agentdash-ota-update.mjs",
  "deploy/agentdash-mac-mini-launchd.mjs",
  "deploy/agentdash-mac-mini-source-launchd.mjs",
  "agent-harness-smoke.mjs",
  "msp-partner-access-proof.mjs",
  "msp-mac-mini-readiness.mjs",
  "ci/check-pr-process.mjs",
  "verify-release-registry-state.mjs",
];

function listMjsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMjsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

test("scripts run when invoked through a symlinked path", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "entry-guard-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  for (const [index, rel] of HELP_SCRIPTS.entries()) {
    const realDir = path.join(SCRIPTS_ROOT, path.dirname(rel));
    // A symlinked directory, mirroring `releases/current` -> `releases/vX-sha`.
    const linkDir = path.join(tmp, `case-${index}`, "current");
    mkdirSync(path.dirname(linkDir), { recursive: true });
    symlinkSync(realDir, linkDir, "dir");
    const invokedPath = path.join(linkDir, path.basename(rel));

    const result = spawnSync(process.execPath, [invokedPath, "--help"], {
      encoding: "utf8",
      timeout: 30_000,
    });

    const output = `${result.stdout}${result.stderr}`;
    assert.notStrictEqual(
      output.trim(),
      "",
      `${rel} produced no output through a symlinked path (status ${result.status}) — ` +
        "the entry guard compared import.meta.url to argv[1] without resolving symlinks",
    );
    assert.strictEqual(result.status, 0, `${rel} --help exited ${result.status}: ${output}`);
  }
});

test("every argv[1]/import.meta.url entry guard compares realpaths", () => {
  const offenders = [];
  for (const file of listMjsFiles(SCRIPTS_ROOT)) {
    if (file.endsWith(".test.mjs")) continue;
    const source = readFileSync(file, "utf8");
    const hasArgvGuard = source.includes("process.argv[1]");
    const hasModuleUrl = source.includes("import.meta.url");
    if (hasArgvGuard && hasModuleUrl && !source.includes("realpathSync")) {
      offenders.push(path.relative(SCRIPTS_ROOT, file));
    }
  }
  assert.deepStrictEqual(
    offenders,
    [],
    "entry guards that compare process.argv[1] to import.meta.url must resolve " +
      "symlinks (realpathSync) — a plain comparison silently skips main() when the " +
      "script is invoked through a symlinked path",
  );
});
