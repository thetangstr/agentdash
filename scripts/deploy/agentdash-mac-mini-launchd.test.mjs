import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildMacMiniLaunchdPlan,
  renderBackupScript,
  renderLaunchdPlist,
  renderMacMiniEnv,
  renderSupervisorScript,
  runMacMiniLaunchdInstall,
} from "./agentdash-mac-mini-launchd.mjs";

test("builds a private pinned-image Mac mini launchd plan", () => {
  const plan = buildMacMiniLaunchdPlan({
    installDir: "/opt/agentdash",
    launchAgentDir: "/Users/operator/Library/LaunchAgents",
    targetImage: "ghcr.io/acme/agentdash:sha-abcdef1",
    imageRepo: "ghcr.io/acme/agentdash",
    publicUrl: "http://100.64.0.10:3100",
    betterAuthSecret: "secret-1",
    postgresPassword: "pg-secret-1",
  });

  assert.equal(plan.env.PAPERCLIP_DEPLOYMENT_MODE, "authenticated");
  assert.equal(plan.env.PAPERCLIP_DEPLOYMENT_EXPOSURE, "private");
  assert.equal(plan.env.AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT, "true");
  assert.equal(plan.env.AGENTDASH_IMAGE, "ghcr.io/acme/agentdash:sha-abcdef1");
  assert.equal(plan.env.AGENTDASH_RUNTIME_ENV_FILE, "/opt/agentdash/agentdash.env");
  assert.equal(plan.paths.plist, "/Users/operator/Library/LaunchAgents/ai.agentdash.agent.plist");
  assert.equal(plan.paths.supervisorScript, "/opt/agentdash/bin/agentdash-compose-supervisor.sh");
});

test("rejects unpinned images for production Mac mini installs", () => {
  assert.throws(
    () => buildMacMiniLaunchdPlan({
      targetImage: "ghcr.io/acme/agentdash:latest",
      publicUrl: "http://100.64.0.10:3100",
      betterAuthSecret: "secret-1",
      postgresPassword: "pg-secret-1",
    }),
    /pinned.*sha/i,
  );
});

test("renders env, launchd plist, supervisor, and backup wrappers", () => {
  const plan = buildMacMiniLaunchdPlan({
    installDir: "/opt/agentdash",
    launchAgentDir: "/Users/operator/Library/LaunchAgents",
    targetImage: "ghcr.io/acme/agentdash:sha-abcdef1",
    imageRepo: "ghcr.io/acme/agentdash",
    publicUrl: "http://100.64.0.10:3100",
    betterAuthSecret: "secret-1",
    postgresPassword: "pg-secret-1",
  });

  const env = renderMacMiniEnv(plan);
  assert.match(env, /^AGENTDASH_IMAGE=ghcr\.io\/acme\/agentdash:sha-abcdef1$/m);
  assert.match(env, /^PAPERCLIP_DEPLOYMENT_MODE=authenticated$/m);
  assert.match(env, /^PAPERCLIP_DEPLOYMENT_EXPOSURE=private$/m);
  assert.match(env, /^AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT=true$/m);
  assert.match(env, /^PAPERCLIP_PUBLIC_URL=http:\/\/100\.64\.0\.10:3100$/m);

  const plist = renderLaunchdPlist(plan);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /agentdash-compose-supervisor\.sh/);

  const supervisor = renderSupervisorScript(plan);
  assert.match(supervisor, /docker compose --env-file "\$ENV_FILE" -f "\$COMPOSE_FILE" up -d db server/);
  assert.match(supervisor, /curl -fsS "\$HEALTH_URL"/);

  const backup = renderBackupScript(plan);
  assert.match(backup, /pg_dump -U "\$\{POSTGRES_USER:-paperclip\}"/);
  assert.match(backup, /predeploy-\$\(date -u \+%Y%m%dT%H%M%SZ\)\.dump/);
});

test("dry run does not write host files", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-mac-mini-plan-"));
  try {
    const result = await runMacMiniLaunchdInstall({
      installDir: path.join(tmp, "install"),
      launchAgentDir: path.join(tmp, "LaunchAgents"),
      targetImage: "ghcr.io/acme/agentdash:sha-abcdef1",
      imageRepo: "ghcr.io/acme/agentdash",
      publicUrl: "http://100.64.0.10:3100",
      betterAuthSecret: "secret-1",
      postgresPassword: "pg-secret-1",
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    assert.throws(() => statSync(path.join(tmp, "install", "agentdash.env")), /ENOENT/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("write mode creates env mode 600 and executable operational wrappers", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "agentdash-mac-mini-install-"));
  try {
    const result = await runMacMiniLaunchdInstall({
      installDir: path.join(tmp, "install"),
      launchAgentDir: path.join(tmp, "LaunchAgents"),
      targetImage: "ghcr.io/acme/agentdash:sha-abcdef1",
      imageRepo: "ghcr.io/acme/agentdash",
      publicUrl: "http://100.64.0.10:3100",
      betterAuthSecret: "secret-1",
      postgresPassword: "pg-secret-1",
      write: true,
    });

    assert.equal(result.dryRun, false);
    assert.equal(statSync(result.plan.paths.envFile).mode & 0o777, 0o600);
    assert.equal(statSync(result.plan.paths.supervisorScript).mode & 0o777, 0o755);
    assert.equal(statSync(result.plan.paths.updateScript).mode & 0o777, 0o755);
    assert.match(readFileSync(result.plan.paths.runbook, "utf8"), /Rollback rehearsal/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
