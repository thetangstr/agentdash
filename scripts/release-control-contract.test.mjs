import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("release workflows run the workspace-link preflight before recursive typecheck", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
  const releaseScript = readFileSync(path.join(repoRoot, "scripts/release.sh"), "utf8");

  assert.doesNotMatch(workflow, /run:\s*pnpm -r typecheck/);
  assert.doesNotMatch(releaseScript, /pnpm -r typecheck/);
  assert.match(releaseScript, /pnpm typecheck/);
  assert.ok(
    [...workflow.matchAll(/name:\s*Typecheck[\s\S]*?run:\s*pnpm typecheck/g)].length >= 2,
    "canary and stable verification must call the root typecheck script",
  );
});

test("stable workflow separates immutable source from release-control metadata", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");

  assert.match(workflow, /name:\s*Checkout release control/);
  assert.match(workflow, /name:\s*Checkout immutable source/);
  assert.match(workflow, /path:\s*release-control/);
  assert.match(workflow, /path:\s*source/);
  assert.match(workflow, /REPO_ROOT:/);
  assert.match(workflow, /export RELEASE_NOTES_FILE=/);
  assert.match(workflow, /name:\s*Verify immutable source provenance/);
  assert.match(workflow, /git rev-parse "\$tag\^\{commit\}"/);
});

test("release scripts honor explicit source and release-notes paths", () => {
  const releaseScript = readFileSync(path.join(repoRoot, "scripts/release.sh"), "utf8");
  const githubReleaseScript = readFileSync(path.join(repoRoot, "scripts/create-github-release.sh"), "utf8");

  assert.match(releaseScript, /if \[ -z "\$\{REPO_ROOT:-\}" \]/);
  assert.match(githubReleaseScript, /if \[ -z "\$\{REPO_ROOT:-\}" \]/);

  const explicitNotes = "/tmp/release-control/releases/v2026.827.0.md";
  const output = execFileSync(
    "bash",
    [
      "-c",
      '. "$1/scripts/release-lib.sh"; release_notes_file 2026.827.0',
      "bash",
      repoRoot,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        REPO_ROOT: repoRoot,
        RELEASE_NOTES_FILE: explicitNotes,
      },
    },
  ).trim();

  assert.equal(output, explicitNotes);
});
