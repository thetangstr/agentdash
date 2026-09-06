import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PR_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "pr.yml");

/**
 * The lockfile gate, pinned so it cannot quietly regress to either of the two
 * weaker checks it replaced.
 *
 * History, because it is the reason this file exists. One check blocked
 * `pnpm-lock.yaml` in any pull request on the grounds that "CI owns lockfile
 * updates". The automation that owned it opened its pull request as a bot, so
 * GitHub parked every check at `action_required` waiting for a human click that
 * never came — and the refresh could not merge. Meanwhile a second check
 * regenerated the lockfile when a manifest changed, but only to see whether the
 * command exited zero; it never compared the result with what was committed.
 *
 * Between them, a manifest change could land with a stale lockfile. It did:
 * `pnpm install --frozen-lockfile` on the default branch failed with
 * ERR_PNPM_LOCKFILE_CONFIG_MISMATCH, which is why every job had to install with
 * `--no-frozen-lockfile` — the unreviewed dependency resolution that a frozen
 * install exists to prevent.
 *
 * The property worth enforcing is not who edited the file. It is whether the
 * file is reproducible from the manifests.
 */
const workflow = readFileSync(PR_WORKFLOW, "utf8");

test("the PR workflow asserts the lockfile matches the manifests", () => {
  assert.match(workflow, /name: Lockfile must match the manifests/);
  assert.match(workflow, /pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile/);
  // Regenerating proves nothing unless the result is compared.
  assert.match(workflow, /git diff --quiet -- pnpm-lock\.yaml/);
});

test("the gate is unconditional", () => {
  const step = workflow.slice(workflow.indexOf("name: Lockfile must match the manifests"));
  const nextStep = step.indexOf("      - name:", 1);
  const body = nextStep === -1 ? step : step.slice(0, nextStep);
  // A manifest-triggered gate is what let drift land: a lockfile can fall out of
  // sync because the BASE moved, with no manifest in the diff at all.
  assert.doesNotMatch(body, /^\s*if:/m, "the lockfile gate must not be conditional");
});

test("the blanket ban on committing a lockfile is gone", () => {
  assert.doesNotMatch(
    workflow,
    /Do not commit pnpm-lock\.yaml in pull requests/,
    "committing the lockfile alongside a manifest change is the supported path now",
  );
  assert.doesNotMatch(
    workflow,
    /head_ref != 'chore\/refresh-lockfile'/,
    "the bot-branch exemption existed only to work around the blanket ban",
  );
});

test("the gate tells a contributor how to fix it", () => {
  assert.match(workflow, /Regenerate it and commit the result/);
});
