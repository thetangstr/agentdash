#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveShardConfig, selectShard } from "./lib/shard.mjs";

const repoRoot = process.cwd();
const serverRoot = path.join(repoRoot, "server");
const serverTestsDir = path.join(repoRoot, "server", "src", "__tests__");
const nonServerProjects = [
  "@paperclipai/shared",
  "@paperclipai/db",
  "@paperclipai/adapter-utils",
  "@paperclipai/adapter-acpx-local",
  // AgentDash: this manifest and vitest.config.ts are maintained separately and
  // had drifted — five adapter packages carried suites that `pnpm test:run`
  // never opened, openclaw-gateway in both manifests. A test nobody runs is the
  // same shape of gap as a function nobody calls.
  "@paperclipai/adapter-claude-local",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-cursor-local",
  "@paperclipai/adapter-gemini-local",
  "@paperclipai/adapter-openclaw-gateway",
  "@paperclipai/adapter-opencode-local",
  "@paperclipai/adapter-pi-local",
  // AgentDash: the MCP server's suites were listed in no runner, so 96 passing
  // tests were never executed by `pnpm test:run`. A test nobody runs is the
  // same shape of gap as a function nobody calls.
  "@agentdash/mcp-server",
  // AgentDash: packages/plugins/* was registered by no runner, so this
  // workspace member's suite ran under neither manifest. Its e2b sibling
  // (packages/plugins/sandbox-providers/e2b) stays out — it is deliberately
  // excluded from the workspace in pnpm-workspace.yaml.
  "@paperclipai/plugin-fake-sandbox",
  "@paperclipai/ui",
  "paperclipai",
];
const routeTestPattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;
const additionalSerializedServerTests = new Set([
  "server/src/__tests__/approval-routes-idempotency.test.ts",
  "server/src/__tests__/assets.test.ts",
  "server/src/__tests__/authz-company-access.test.ts",
  "server/src/__tests__/companies-route-path-guard.test.ts",
  "server/src/__tests__/company-portability.test.ts",
  "server/src/__tests__/costs-service.test.ts",
  "server/src/__tests__/express5-auth-wildcard.test.ts",
  "server/src/__tests__/health-dev-server-token.test.ts",
  "server/src/__tests__/health.test.ts",
  "server/src/__tests__/heartbeat-dependency-scheduling.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
  "server/src/__tests__/heartbeat-process-recovery.test.ts",
  "server/src/__tests__/invite-accept-existing-member.test.ts",
  "server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "server/src/__tests__/invite-accept-replay.test.ts",
  "server/src/__tests__/invite-expiry.test.ts",
  "server/src/__tests__/invite-join-manager.test.ts",
  "server/src/__tests__/invite-onboarding-text.test.ts",
  "server/src/__tests__/issues-checkout-wakeup.test.ts",
  "server/src/__tests__/issues-service.test.ts",
  "server/src/__tests__/opencode-local-adapter-environment.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/redaction.test.ts",
  "server/src/__tests__/routines-e2e.test.ts",
]);
let invocationIndex = 0;

/**
 * Sharding: see scripts/lib/shard.mjs for why the units can be split and why
 * the split has to be deterministic. Default is 1/1 — everything, as before.
 */
const { count: shardCount, index: shardIndex } = resolveShardConfig();

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...walk(absolute));
    } else if (stats.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function toRepoPath(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function toServerPath(file) {
  return path.relative(serverRoot, file).split(path.sep).join("/");
}

function isRouteOrAuthzTest(file) {
  if (routeTestPattern.test(file)) {
    return true;
  }

  return additionalSerializedServerTests.has(file);
}

function runVitest(args, label) {
  console.log(`\n[test:run] ${label}`);
  invocationIndex += 1;
  const testRoot = mkdtempSync(path.join(os.tmpdir(), `paperclip-vitest-${process.pid}-${invocationIndex}-`));
  const env = {
    ...process.env,
    PAPERCLIP_HOME: path.join(testRoot, "home"),
    PAPERCLIP_INSTANCE_ID: `vitest-${process.pid}-${invocationIndex}`,
    TMPDIR: path.join(testRoot, "tmp"),
  };
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  const result = spawnSync("pnpm", ["exec", "vitest", "run", ...args], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[test:run] Failed to start Vitest: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const routeTests = walk(serverTestsDir)
  .filter((file) => isRouteOrAuthzTest(toRepoPath(file)))
  .map((file) => ({
    repoPath: toRepoPath(file),
    serverPath: toServerPath(file),
  }))
  .sort((a, b) => a.repoPath.localeCompare(b.repoPath));

const excludeRouteArgs = routeTests.flatMap((file) => ["--exclude", file.serverPath]);

if (shardCount > 1) {
  console.log(`[test:run] shard ${shardIndex} of ${shardCount}`);
}

for (const project of selectShard(nonServerProjects, { index: shardIndex, count: shardCount })) {
  runVitest(["--project", project], `non-server project ${project}`);
}

// The server bulk is one unit and cannot be split without re-deriving the
// exclude list, so it rides on the first shard. It is the largest single unit,
// which is why the serialized suites are dealt from the other end below.
if (shardIndex === 1) {
  runVitest(
    ["--project", "@paperclipai/server", ...excludeRouteArgs],
    `server suites excluding ${routeTests.length} serialized suites`,
  );
}

for (const routeTest of selectShard([...routeTests].reverse(), { index: shardIndex, count: shardCount })) {
  runVitest(
    [
      "--project",
      "@paperclipai/server",
      routeTest.repoPath,
      "--pool=forks",
      "--poolOptions.forks.isolate=true",
    ],
    routeTest.repoPath,
  );
}
