import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const DOCKER_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "docker.yml");

/**
 * The UI's `tsc -b` resolves @paperclipai/adapter-utils, @paperclipai/shared and
 * the adapter packages from their built output. The image built the UI first,
 * so every push to main from 2026-08-27 to 2026-09-01 failed with
 * "Cannot find module '@paperclipai/adapter-utils'" — and nobody noticed,
 * because the Docker workflow is not a required check and only ran on main.
 *
 * Two guards: the Dockerfile builds the workspace packages before the UI, and
 * the workflow builds on pull requests so the next regression fails the PR.
 */
test("Dockerfile builds the workspace packages before the UI", () => {
  const lines = readFileSync(DOCKERFILE, "utf8").split("\n");
  const packagesBuild = lines.findIndex((line) => /^RUN pnpm --filter "@paperclipai\/ui\^\.\.\." --filter "@paperclipai\/server\^\.\.\." build/.test(line));
  const uiBuild = lines.findIndex((line) => /^RUN pnpm --filter @paperclipai\/ui build/.test(line));
  const serverBuild = lines.findIndex((line) => /^RUN pnpm --filter @paperclipai\/server build/.test(line));
  assert.notEqual(packagesBuild, -1, "Dockerfile must build the UI and server workspace dependencies explicitly");
  assert.notEqual(uiBuild, -1, "Dockerfile must build @paperclipai/ui");
  assert.notEqual(serverBuild, -1, "Dockerfile must build @paperclipai/server");
  assert.ok(packagesBuild < uiBuild, "workspace packages must be built before the UI");
  assert.ok(packagesBuild < serverBuild, "workspace packages must be built before the server");
});

test("Docker workflow builds on pull requests without pushing", () => {
  const source = readFileSync(DOCKER_WORKFLOW, "utf8");
  assert.match(source, /^\s+pull_request:\s*$/m, "docker.yml must trigger on pull_request");
  assert.match(
    source,
    /push:\s*\$\{\{\s*github\.event_name\s*!=\s*'pull_request'\s*\}\}/,
    "image push must be disabled for pull requests",
  );
  assert.match(
    source,
    /Login to GitHub Container Registry[\s\S]*?if:\s*github\.event_name\s*!=\s*'pull_request'/,
    "registry login must be skipped for pull requests",
  );
});
