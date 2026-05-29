import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildMacMiniSourceLaunchdPlan,
  mergeSourceEnv,
  renderSourceBackupScript,
  renderSourceLaunchdPlist,
  renderSourceSupervisorScript,
  renderSourceUpdateScript,
  runMacMiniSourceLaunchdInstall,
} from "./agentdash-mac-mini-source-launchd.mjs";

test("builds a private pinned-SHA source-checkout Mac mini launchd plan", () => {
  const plan = buildMacMiniSourceLaunchdPlan({
    repoDir: "/Users/operator/workspace/agentdash_msp_launch",
    targetSha: "0fb91d408f6082030a629c079df99902f81e3df4",
    publicUrl: "http://100.64.0.10:3100",
    envFile: "/Users/operator/.config/agentdash/agentdash.env",
    agentdashHome: "/Users/operator/.agentdash",
    stateDir: "/Users/operator/.agentdash/deployments",
    launchAgentDir: "/Users/operator/Library/LaunchAgents",
  });

  assert.equal(plan.targetSha, "0fb91d408f6082030a629c079df99902f81e3df4");
  assert.equal(plan.env.PAPERCLIP_DEPLOYMENT_MODE, "authenticated");
  assert.equal(plan.env.PAPERCLIP_DEPLOYMENT_EXPOSURE, "private");
  assert.equal(plan.env.AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT, "true");
  assert.equal(plan.env.AGENTDASH_SOURCE_SHA, "0fb91d408f6082030a629c079df99902f81e3df4");
  assert.equal(plan.paths.plist, "/Users/operator/Library/LaunchAgents/ai.agentdash.agent.plist");
  assert.equal(plan.paths.supervisorScript, "/Users/operator/.agentdash/bin/agentdash-source-supervisor.sh");
});

test("rejects unpinned source SHAs", () => {
  assert.throws(
    () => buildMacMiniSourceLaunchdPlan({
      repoDir: "/Users/operator/workspace/agentdash_msp_launch",
      targetSha: "main",
      publicUrl: "http://100.64.0.10:3100",
    }),
    /targetSha.*git SHA/i,
  );
});

test("merges launch-required env without dropping existing secrets", () => {
  const plan = buildMacMiniSourceLaunchdPlan({
    repoDir: "/Users/operator/workspace/agentdash_msp_launch",
    targetSha: "0fb91d4",
    publicUrl: "http://100.64.0.10:3100",
  });

  const merged = mergeSourceEnv("BETTER_AUTH_SECRET=existing\nCUSTOM=value\n", plan);

  assert.match(merged, /^BETTER_AUTH_SECRET=existing$/m);
  assert.match(merged, /^CUSTOM=value$/m);
  assert.match(merged, /^PAPERCLIP_DEPLOYMENT_MODE=authenticated$/m);
  assert.match(merged, /^PAPERCLIP_DEPLOYMENT_EXPOSURE=private$/m);
  assert.match(merged, /^AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT=true$/m);
  assert.match(merged, /^AGENTDASH_SOURCE_SHA=0fb91d4$/m);
  assert.match(merged, /^PAPERCLIP_PUBLIC_URL=http:\/\/100\.64\.0\.10:3100$/m);
});

test("renders source supervisor with pinned SHA and launchd service shape", () => {
  const plan = buildMacMiniSourceLaunchdPlan({
    repoDir: "/Users/operator/workspace/agentdash_msp_launch",
    targetSha: "0fb91d408f6082030a629c079df99902f81e3df4",
    publicUrl: "http://100.64.0.10:3100",
    envFile: "/Users/operator/.config/agentdash/agentdash.env",
  });

  const supervisor = renderSourceSupervisorScript(plan);
  assert.match(supervisor, /EXPECTED_SHA="\$\{AGENTDASH_SOURCE_SHA:-0fb91d408f6082030a629c079df99902f81e3df4\}"/);
  assert.match(supervisor, /pnpm --filter @paperclipai\/server exec tsx src\/index\.ts/);
  assert.match(supervisor, /git rev-parse HEAD/);

  const plist = renderSourceLaunchdPlist(plan);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /agentdash-source-supervisor\.sh/);

  const backup = renderSourceBackupScript(plan);
  assert.match(backup, /pg_dump "\$DATABASE_URL"/);
  assert.match(backup, /PAPERCLIP_EMBEDDED_POSTGRES_PORT/);

  const update = renderSourceUpdateScript(plan);
  assert.match(update, /git fetch --all --tags/);
  assert.match(update, /pnpm install --frozen-lockfile/);
  assert.match(update, /"AGENTDASH_SOURCE_SHA=" \+ sha/);
  assert.match(update, /launchctl kickstart -k/);
});

test("write mode creates source launchd files with protected env mode", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-source-launchd-"));
  try {
    const repoDir = path.join(tmp, "repo");
    const result = await runMacMiniSourceLaunchdInstall({
      repoDir,
      targetSha: "0fb91d408f6082030a629c079df99902f81e3df4",
      publicUrl: "http://100.64.0.10:3100",
      envFile: path.join(tmp, "config", "agentdash.env"),
      agentdashHome: path.join(tmp, "home"),
      launchAgentDir: path.join(tmp, "LaunchAgents"),
      betterAuthSecret: "secret-1",
      agentJwtSecret: "jwt-1",
      write: true,
    });

    assert.equal(result.dryRun, false);
    assert.equal(statSync(result.plan.paths.envFile).mode & 0o777, 0o600);
    assert.equal(statSync(result.plan.paths.supervisorScript).mode & 0o777, 0o755);
    assert.equal(statSync(result.plan.paths.updateScript).mode & 0o777, 0o755);
    assert.match(readFileSync(result.plan.paths.runbook, "utf8"), /source-checkout/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
