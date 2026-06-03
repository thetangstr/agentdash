import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReadinessPlan,
  evaluateEnvContent,
  evaluateFeatureFlagPayload,
  evaluateHealthPayload,
  normalizeBaseUrl,
  summarizeReadiness,
} from "./msp-mac-mini-readiness.mjs";

test("normalizes base URLs and health URL", () => {
  assert.equal(normalizeBaseUrl("http://100.64.0.10:3100/"), "http://100.64.0.10:3100");
  assert.equal(
    buildReadinessPlan({
      baseUrl: "http://100.64.0.10:3100/",
      runBackup: true,
      runInstanceBackup: true,
      backupCommand: "/opt/agentdash/bin/agentdash-backup-db.sh",
      instanceBackupCommand: "tar -czf /tmp/agentdash-instance.tgz /opt/agentdash",
    }).healthUrl,
    "http://100.64.0.10:3100/api/health",
  );
});

test("requires authenticated ready private health for launch readiness", () => {
  const checks = evaluateHealthPayload({
    status: "ok",
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authReady: true,
    bootstrapStatus: "ready",
  });

  assert.equal(summarizeReadiness(checks).fail, 0);
  assert.equal(checks.find((check) => check.name === "deployment_mode")?.status, "pass");
});

test("fails health evaluation for public exposure or pending bootstrap", () => {
  const checks = evaluateHealthPayload({
    status: "ok",
    deploymentMode: "authenticated",
    deploymentExposure: "public",
    authReady: true,
    bootstrapStatus: "bootstrap_pending",
  });

  const summary = summarizeReadiness(checks);
  assert.equal(summary.fail, 2);
  assert.equal(checks.find((check) => check.name === "deployment_exposure")?.status, "fail");
  assert.equal(checks.find((check) => check.name === "bootstrap_status")?.status, "fail");
});

test("plans explicit backup and instance backup checks", () => {
  const plan = buildReadinessPlan({
    baseUrl: "http://100.64.0.10:3100",
    runBackup: true,
    runInstanceBackup: true,
    runAgentHarnessSmoke: true,
    envFile: "/opt/agentdash/agentdash.env",
    expectedCompanyId: "company-1",
    authHeader: "Bearer readiness-token",
    backupCommand: "db-backup",
    instanceBackupCommand: "instance-backup",
    agentHarnessCommand: "agent-harness-smoke",
  });

  assert.deepEqual(plan.backupChecks.map((check) => check.name), [
    "database_backup",
    "instance_backup",
    "agent_harness_smoke",
  ]);
  assert.equal(plan.envFile, "/opt/agentdash/agentdash.env");
  assert.equal(
    plan.dodGuardUrl,
    "http://100.64.0.10:3100/api/companies/company-1/feature-flags/dod_guard_enabled",
  );
  assert.deepEqual(plan.headers, { authorization: "Bearer readiness-token" });
});

test("evaluates DoD guard feature flag payloads", () => {
  const passing = evaluateFeatureFlagPayload({ flagKey: "dod_guard_enabled", enabled: true });
  const failing = evaluateFeatureFlagPayload({ flagKey: "dod_guard_enabled", enabled: false });

  assert.equal(passing.status, "pass");
  assert.equal(failing.status, "fail");
});

test("evaluates env file evidence for private authenticated pinned-image runtime", () => {
  const checks = evaluateEnvContent([
    "PAPERCLIP_DEPLOYMENT_MODE=authenticated",
    "PAPERCLIP_DEPLOYMENT_EXPOSURE=private",
    "AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT=true",
    "BETTER_AUTH_SECRET=secret",
    "AGENTDASH_IMAGE=ghcr.io/acme/agentdash:sha-abcdef1",
    "",
  ].join("\n"));

  assert.equal(summarizeReadiness(checks).fail, 0);
  assert.equal(checks.find((check) => check.name === "env_deployment_exposure")?.status, "pass");
  assert.equal(checks.find((check) => check.name === "env_harness_preflight_required")?.status, "pass");
  assert.equal(checks.find((check) => check.name === "env_pinned_runtime")?.status, "pass");
});

test("evaluates env file evidence for private authenticated pinned-source runtime", () => {
  const checks = evaluateEnvContent([
    "PAPERCLIP_DEPLOYMENT_MODE=authenticated",
    "PAPERCLIP_DEPLOYMENT_EXPOSURE=private",
    "AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT=true",
    "BETTER_AUTH_SECRET=secret",
    "AGENTDASH_SOURCE_SHA=0fb91d408f6082030a629c079df99902f81e3df4",
    "",
  ].join("\n"));

  assert.equal(summarizeReadiness(checks).fail, 0);
  assert.equal(checks.find((check) => check.name === "env_pinned_runtime")?.status, "pass");
});

test("fails env file evidence when launch-critical runtime settings are unsafe", () => {
  const checks = evaluateEnvContent([
    "PAPERCLIP_DEPLOYMENT_MODE=local_trusted",
    "PAPERCLIP_DEPLOYMENT_EXPOSURE=public",
    "AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT=false",
    "BETTER_AUTH_SECRET=",
    "AGENTDASH_IMAGE=ghcr.io/acme/agentdash:latest",
  ].join("\n"));

  assert.equal(summarizeReadiness(checks).fail, 5);
  assert.equal(checks.find((check) => check.name === "env_deployment_mode")?.status, "fail");
  assert.equal(checks.find((check) => check.name === "env_harness_preflight_required")?.status, "fail");
  assert.equal(checks.find((check) => check.name === "env_auth_secret")?.status, "fail");
});

test("rejects backup flags without commands", () => {
  assert.throws(
    () => buildReadinessPlan({
      baseUrl: "http://100.64.0.10:3100",
      runBackup: true,
    }),
    /backup-command/,
  );
  assert.throws(
    () => buildReadinessPlan({
      baseUrl: "http://100.64.0.10:3100",
      runInstanceBackup: true,
    }),
    /instance-backup-command/,
  );
  assert.throws(
    () => buildReadinessPlan({
      baseUrl: "http://100.64.0.10:3100",
      runAgentHarnessSmoke: true,
    }),
    /agent-harness-command/,
  );
});
