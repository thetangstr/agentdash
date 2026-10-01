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
    /name: Build \(pull request, not pushed\)\s*\n\s*if: github\.event_name == 'pull_request'[\s\S]*?push: false/,
    "the pull-request build must not push",
  );
  assert.match(
    source,
    /name: Build and push by digest\s*\n\s*id: build\s*\n\s*if: github\.event_name != 'pull_request'/,
    "only non-pull-request builds may push",
  );
  assert.match(
    source,
    /\n  merge:\s*\n\s*if: github\.event_name != 'pull_request'/,
    "the manifest merge must not run on pull requests",
  );
  assert.match(
    source,
    /Login to GitHub Container Registry[\s\S]*?if:\s*github\.event_name\s*!=\s*'pull_request'/,
    "registry login must be skipped for pull requests",
  );
});

/**
 * AgentDash (#775): the emulated (QEMU) arm64 build ran past the 30-minute
 * limit, so every push to main was cancelled and `latest` / `sha-*` went stale.
 * Each platform builds on its own native runner; a merge job names the index.
 */
test("Docker workflow builds each platform natively and never cancels main", () => {
  const source = readFileSync(DOCKER_WORKFLOW, "utf8");
  assert.match(source, /platform: linux\/amd64\s*\n\s*arch: amd64\s*\n\s*runner: ubuntu-latest/);
  assert.match(source, /platform: linux\/arm64\s*\n\s*arch: arm64\s*\n\s*runner: ubuntu-24\.04-arm/);
  assert.doesNotMatch(source, /platforms:\s*[^\n]*linux\/amd64,linux\/arm64/, "no single-runner (emulated) multi-arch build");
  assert.doesNotMatch(source, /setup-qemu-action/, "no QEMU emulation");
  assert.match(source, /push-by-digest=true/);
  assert.match(source, /docker buildx imagetools create/);
  assert.match(source, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/, "only pull requests cancel superseded runs");
});

test("Docker workflow leaves new release tags to release.yml and only backfills missing ones", () => {
  const source = readFileSync(DOCKER_WORKFLOW, "utf8");
  // release.yml pushes tags with GITHUB_TOKEN, which never triggers a workflow,
  // and its image jobs enforce tag immutability; a `v*` trigger here was dead.
  assert.doesNotMatch(source, /^\s+tags:\s*$/m, "docker.yml must not trigger on tag pushes");
  assert.doesNotMatch(source, /type=semver/, "no semver tags outside the release path");
  assert.match(source, /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*release_tag:/);
  assert.match(source, /release-image\.mjs tags/, "release tag names come from the shared helper");
  assert.match(source, /never overwritten/);
});
