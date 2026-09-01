import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validatePullRequestBody } from "./check-pr-process.mjs";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const BODY_PATH = path.join(REPO_ROOT, ".github", "pr-bodies", "lockfile-refresh.md");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "refresh-lockfile.yml");

/**
 * The lockfile refresh workflow opens its own PR, and that PR has to pass the
 * same body policy as everyone else's.
 *
 * It did not. `policy` failed on every refresh, the verify shards skipped
 * behind it, and the PR could never merge — so `main` drifted to a lockfile it
 * cannot install from: `pnpm install --frozen-lockfile` on the default branch
 * fails with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH, which is why every CI job
 * installs with `--no-frozen-lockfile`.
 *
 * The body now lives in a committed file so it can be checked here, rather than
 * being discovered broken by an automation nobody watches.
 */
test("the lockfile PR body passes the policy every other PR must pass", () => {
  const { errors } = validatePullRequestBody(readFileSync(BODY_PATH, "utf8"));
  assert.deepEqual(errors, [], `lockfile PR body would be rejected:\n${errors.join("\n")}`);
});

test("the workflow actually uses that file", () => {
  // A compliant body helps nobody if the workflow still passes --body inline.
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");
  assert.match(workflow, /--body-file \.github\/pr-bodies\/lockfile-refresh\.md/);
});

test("the body says it is machine-generated rather than claiming a model wrote it", () => {
  const body = readFileSync(BODY_PATH, "utf8");
  assert.match(body, /human-authored/i);
  assert.match(body, /refresh-lockfile\.yml/);
});
