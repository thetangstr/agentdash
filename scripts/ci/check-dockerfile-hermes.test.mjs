import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DOCKERFILE = readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
const DOCKER_WORKFLOW = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "docker.yml"), "utf8");

/**
 * AgentDash (#721): Hermes is the only runtime on a hosted 1.0 box. These
 * guards keep its install pinned and its state on the Volume. The image itself
 * is exercised by scripts/docker/hermes-smoke.sh in the Docker workflow.
 */
test("Hermes is pinned to a tag and its commit", () => {
  assert.match(DOCKERFILE, /^ARG HERMES_REF=v\d{4}\.\d{1,2}\.\d{1,2}$/m, "HERMES_REF must name a release tag");
  assert.match(DOCKERFILE, /^ARG HERMES_COMMIT=[0-9a-f]{40}$/m, "HERMES_COMMIT must be a full commit sha");
  assert.match(
    DOCKERFILE,
    /test "\$\(git -C \/opt\/hermes rev-parse HEAD\)" = "\$HERMES_COMMIT"/,
    "the build must verify the cloned tag resolves to HERMES_COMMIT",
  );
});

test("Hermes dependencies install from its lockfile with a digest-pinned uv", () => {
  assert.match(DOCKERFILE, /^FROM ghcr\.io\/astral-sh\/uv:[\d.]+@sha256:[0-9a-f]{64} AS uv_source$/m);
  assert.match(DOCKERFILE, /uv sync --frozen --no-dev/, "uv sync must use --frozen (uv.lock hashes, no re-resolve)");
});

test("the production image ships a working hermes on PATH", () => {
  assert.match(DOCKERFILE, /COPY --from=hermes \/opt\/hermes \/opt\/hermes/);
  assert.match(DOCKERFILE, /ln -s \/opt\/hermes\/\.venv\/bin\/hermes \/usr\/local\/bin\/hermes/);
  assert.match(DOCKERFILE, /&& hermes --version/);
});

test("Hermes state and wrappers default to the /paperclip Volume, without HERMES_HOME", () => {
  for (const [key, value] of [
    ["AGENTDASH_HERMES_ROOT", "/paperclip/.hermes"],
    ["HERMES_PROFILES_DIR", "/paperclip/.hermes/profiles"],
    ["AGENTDASH_HERMES_BIN_DIR", "/paperclip/.hermes/bin"],
    ["AGENTDASH_HERMES_MANAGED_PROFILES", "true"],
    ["AGENTDASH_DEFAULT_ADAPTER", "hermes_local"],
  ]) {
    assert.match(DOCKERFILE, new RegExp(`^\\s*${key}=${value.replace(/[./]/g, "\\$&")}\\b`, "m"), `${key}=${value}`);
  }
  assert.match(DOCKERFILE, /^\s*HOME=\/paperclip\b/m, "HOME must stay on the Volume so Hermes' root is /paperclip/.hermes");
  // A server-wide HERMES_HOME makes every run's ledger resolve to the root state.db.
  assert.doesNotMatch(DOCKERFILE, /^\s*(ENV\s+)?HERMES_HOME=/m, "HERMES_HOME must not be set in the image");
});

test("the Docker workflow smoke-tests Hermes on pull requests", () => {
  assert.match(DOCKER_WORKFLOW, /scripts\/docker\/hermes-smoke\.sh/);
  assert.match(DOCKER_WORKFLOW, /load:\s*\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*\}\}/);
});
