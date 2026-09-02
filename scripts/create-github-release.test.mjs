// `create-github-release.sh` must run with no `--asset`.
//
// Testing this honestly needs two kinds of assertion, because the bug is
// platform-specific and CI cannot see it.
//
// The behavioural tests below confirm the script does the right thing with no
// assets, with a good asset, and with a missing one. On Linux CI those would
// pass even against the broken version, because expanding an empty array under
// `set -u` is only an error in bash 3.2 — and bash 3.2 is what `/bin/bash`
// still is on macOS, where releases are cut by hand.
//
// So there is also a structural assertion that every `"${assets[@]}"`
// expansion is guarded by a length check. That is the part that actually pins
// the fix for the platform that hit it, and it is why this file asserts on
// source text rather than only on behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPTS_DIR);
const SCRIPT = path.join(SCRIPTS_DIR, "create-github-release.sh");

/** A version whose release notes are committed, so --dry-run gets that far. */
const VERSION = "2026.827.2";
const NOTES = path.join("releases", `v${VERSION}.md`);

function run(args) {
  try {
    return {
      status: 0,
      stdout: execFileSync(SCRIPT, args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      stderr: "",
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

test("every assets[@] expansion is guarded by a length check", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const lines = source.split("\n");

  const expansions = lines
    .map((line, index) => ({ line, number: index + 1 }))
    // Comments mention the expansion when explaining it; only real code counts.
    .filter((entry) => !entry.line.trim().startsWith("#"))
    .filter((entry) => entry.line.includes('"${assets[@]}"'));

  assert.ok(expansions.length > 0, "expected the script to expand the assets array somewhere");

  for (const { line, number } of expansions) {
    // Either the expansion is itself inside a guarded block that opened on an
    // earlier line, or it is on a line that is guarded in place.
    const preceding = lines.slice(0, number).reverse();
    const guardIndex = preceding.findIndex((candidate) =>
      candidate.includes('"${#assets[@]}"') && candidate.includes("-gt 0"),
    );
    const closeIndex = preceding.findIndex((candidate) => candidate.trim() === "fi");
    const guarded = guardIndex !== -1 && (closeIndex === -1 || guardIndex < closeIndex);
    assert.ok(
      guarded,
      `line ${number} expands "\${assets[@]}" without a preceding length guard, which is an `
      + `unbound-variable error under set -u on bash 3.2 (macOS): ${line.trim()}`,
    );
  }
});

test("runs with no assets at all", () => {
  const result = run([VERSION, "--dry-run"]);
  assert.equal(result.status, 0, `expected success, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /gh release create v2026\.827\.2/);
  assert.match(result.stdout, /--notes-file/);
  assert.doesNotMatch(result.stdout, /--asset/, "no asset was passed, so none should be echoed");
});

test("still echoes an asset that was passed", () => {
  const result = run([VERSION, "--asset", NOTES, "--dry-run"]);
  assert.equal(result.status, 0, `expected success, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /--asset/);
  assert.match(result.stdout, /v2026\.827\.2\.md/);
});

test("still refuses an asset path that does not exist", () => {
  const result = run([VERSION, "--asset", "/nope/definitely-missing.json", "--dry-run"]);
  assert.notEqual(result.status, 0, "a missing asset must fail rather than be skipped");
  assert.match(result.stderr, /release asset not found/);
});

test("still requires release notes to exist", () => {
  const result = run(["1999.101.0", "--dry-run"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release notes file not found/);
});
