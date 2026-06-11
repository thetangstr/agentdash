#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

function nowIso() {
  return new Date().toISOString();
}

export function normalizeBaseUrl(value) {
  if (!value || typeof value !== "string") {
    throw new Error("--base-url is required");
  }
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function evaluateHealthPayload(payload) {
  const checks = [];
  const read = (key) => payload && typeof payload === "object" ? payload[key] : undefined;

  checks.push({
    name: "health_status",
    status: read("status") === "ok" ? "pass" : "fail",
    detail: `status=${String(read("status") ?? "missing")}`,
  });
  checks.push({
    name: "deployment_mode",
    status: read("deploymentMode") === "authenticated" ? "pass" : "fail",
    detail: `deploymentMode=${String(read("deploymentMode") ?? "missing")}`,
  });

  if (read("deploymentExposure") !== undefined) {
    checks.push({
      name: "deployment_exposure",
      status: read("deploymentExposure") === "private" ? "pass" : "fail",
      detail: `deploymentExposure=${String(read("deploymentExposure"))}`,
    });
  } else {
    checks.push({
      name: "deployment_exposure",
      status: "warn",
      detail: "deploymentExposure hidden by unauthenticated health response; verify with authenticated health or env evidence",
    });
  }

  if (read("authReady") !== undefined) {
    checks.push({
      name: "auth_ready",
      status: read("authReady") === true ? "pass" : "fail",
      detail: `authReady=${String(read("authReady"))}`,
    });
  } else {
    checks.push({
      name: "auth_ready",
      status: "warn",
      detail: "authReady hidden by unauthenticated health response; verify with authenticated health or env evidence",
    });
  }

  checks.push({
    name: "bootstrap_status",
    status: read("bootstrapStatus") === "ready" ? "pass" : "fail",
    detail: `bootstrapStatus=${String(read("bootstrapStatus") ?? "missing")}`,
  });

  return checks;
}

export function evaluateFeatureFlagPayload(payload) {
  const flagKey = payload && typeof payload === "object" ? payload.flagKey : undefined;
  const enabled = payload && typeof payload === "object" ? payload.enabled : undefined;
  return {
    name: "dod_guard_enabled",
    status: flagKey === "dod_guard_enabled" && enabled === true ? "pass" : "fail",
    detail: `dod_guard_enabled=${String(enabled ?? "missing")}`,
  };
}

export function summarizeReadiness(checks) {
  return checks.reduce(
    (summary, check) => {
      summary[check.status] += 1;
      return summary;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
}

function parseEnvContent(content) {
  const env = {};
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function evaluateEnvContent(content) {
  const env = parseEnvContent(content);
  const image = env.AGENTDASH_IMAGE ?? "";
  const sourceSha = env.AGENTDASH_SOURCE_SHA ?? "";
  const imagePinned = /:sha-[0-9a-f]{7,40}$/i.test(image);
  const sourcePinned = /^[0-9a-f]{7,40}$/i.test(sourceSha);
  const pinnedRuntime = imagePinned || sourcePinned;
  const pinnedRuntimeDetail = imagePinned
    ? `AGENTDASH_IMAGE=${image}`
    : sourcePinned
      ? `AGENTDASH_SOURCE_SHA=${sourceSha}`
      : "AGENTDASH_IMAGE sha tag or AGENTDASH_SOURCE_SHA is missing";
  return [
    {
      name: "env_deployment_mode",
      status: env.PAPERCLIP_DEPLOYMENT_MODE === "authenticated" ? "pass" : "fail",
      detail: `PAPERCLIP_DEPLOYMENT_MODE=${env.PAPERCLIP_DEPLOYMENT_MODE || "missing"}`,
    },
    {
      name: "env_deployment_exposure",
      status: env.PAPERCLIP_DEPLOYMENT_EXPOSURE === "private" ? "pass" : "fail",
      detail: `PAPERCLIP_DEPLOYMENT_EXPOSURE=${env.PAPERCLIP_DEPLOYMENT_EXPOSURE || "missing"}`,
    },
    {
      name: "env_harness_preflight_required",
      status: env.AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT === "true" ? "pass" : "fail",
      detail: `AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT=${env.AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT || "missing"}`,
    },
    {
      name: "env_auth_secret",
      status: env.BETTER_AUTH_SECRET ? "pass" : "fail",
      detail: env.BETTER_AUTH_SECRET ? "BETTER_AUTH_SECRET is set" : "BETTER_AUTH_SECRET is missing",
    },
    {
      name: "env_pinned_runtime",
      status: pinnedRuntime ? "pass" : "fail",
      detail: pinnedRuntimeDetail,
    },
  ];
}

export function buildReadinessPlan(input = {}) {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const backupChecks = [];
  const headers = {};

  if (input.authHeader) {
    headers.authorization = input.authHeader;
  }

  if (input.runBackup) {
    if (!input.backupCommand) {
      throw new Error("--run-backup requires --backup-command");
    }
    backupChecks.push({ name: "database_backup", command: input.backupCommand });
  }

  if (input.runInstanceBackup) {
    if (!input.instanceBackupCommand) {
      throw new Error("--run-instance-backup requires --instance-backup-command");
    }
    backupChecks.push({ name: "instance_backup", command: input.instanceBackupCommand });
  }

  if (input.runAgentHarnessSmoke) {
    if (!input.agentHarnessCommand) {
      throw new Error("--run-agent-harness-smoke requires --agent-harness-command");
    }
    backupChecks.push({ name: "agent_harness_smoke", command: input.agentHarnessCommand });
  }

  return {
    baseUrl,
    healthUrl: `${baseUrl}/api/health`,
    dodGuardUrl: input.expectedCompanyId
      ? `${baseUrl}/api/companies/${encodeURIComponent(input.expectedCompanyId)}/feature-flags/dod_guard_enabled`
      : null,
    headers,
    envFile: input.envFile ?? null,
    backupChecks,
    json: Boolean(input.json),
  };
}

function runShell(command, name) {
  const startedAt = nowIso();
  const result = spawnSync(command, { shell: true, encoding: "utf8" });
  return {
    name,
    status: result.status === 0 ? "pass" : "fail",
    detail: result.status === 0
      ? (result.stdout.trim() || "completed")
      : (result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`),
    startedAt,
    finishedAt: nowIso(),
  };
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { cache: "no-store", headers });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Expected JSON from ${url}; received: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
  }
  return body;
}

export async function runReadiness(input = {}) {
  const plan = buildReadinessPlan(input);
  const checks = [];

  try {
    const health = await fetchJson(plan.healthUrl, plan.headers);
    checks.push(...evaluateHealthPayload(health));
  } catch (error) {
    checks.push({
      name: "health_fetch",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (plan.dodGuardUrl) {
    try {
      const featureFlag = await fetchJson(plan.dodGuardUrl, plan.headers);
      checks.push(evaluateFeatureFlagPayload(featureFlag));
    } catch (error) {
      checks.push({
        name: "dod_guard_enabled",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (plan.envFile) {
    try {
      checks.push(...evaluateEnvContent(readFileSync(plan.envFile, "utf8")));
    } catch (error) {
      checks.push({
        name: "runtime_env_file",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const backup of plan.backupChecks) {
    checks.push(runShell(backup.command, backup.name));
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    baseUrl: plan.baseUrl,
    generatedAt: nowIso(),
    summary: summarizeReadiness(checks),
    checks,
  };
}

function printHuman(result) {
  console.log(`Mac mini readiness for ${result.baseUrl}`);
  for (const check of result.checks) {
    console.log(`${check.status.toUpperCase()}\t${check.name}\t${check.detail}`);
  }
  console.log(`Summary: ${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail`);
}

function printHelp() {
  console.log(`Usage:
  scripts/msp-mac-mini-readiness.sh --base-url <tailnet-url> [options]

Options:
  --base-url <url>                    Required private AgentDash URL.
  --expected-company-id <id>          Verify dod_guard_enabled for this company.
  --auth-header-env <env-var>         Optional env var containing an Authorization header for authenticated checks.
  --env-file <path>                   Runtime env file to verify private/authenticated pinned-image settings.
  --run-backup                        Run a database backup command.
  --backup-command <command>          Command for --run-backup.
  --run-instance-backup               Run an instance-files backup command.
  --instance-backup-command <command> Command for --run-instance-backup.
  --run-agent-harness-smoke           Run the launch agent harness smoke command.
  --agent-harness-command <command>   Command for --run-agent-harness-smoke.
  --json                              Print JSON instead of human text.
  --help                              Show help.
`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string" },
      "expected-company-id": { type: "string" },
      "auth-header-env": { type: "string" },
      "env-file": { type: "string" },
      "run-backup": { type: "boolean" },
      "backup-command": { type: "string" },
      "run-instance-backup": { type: "boolean" },
      "instance-backup-command": { type: "string" },
      "run-agent-harness-smoke": { type: "boolean" },
      "agent-harness-command": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  const result = await runReadiness({
    baseUrl: values["base-url"],
    expectedCompanyId: values["expected-company-id"],
    authHeader: values["auth-header-env"] ? process.env[values["auth-header-env"]] : undefined,
    envFile: values["env-file"],
    runBackup: values["run-backup"],
    backupCommand: values["backup-command"],
    runInstanceBackup: values["run-instance-backup"],
    instanceBackupCommand: values["instance-backup-command"],
    runAgentHarnessSmoke: values["run-agent-harness-smoke"],
    agentHarnessCommand: values["agent-harness-command"],
    json: values.json,
  });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[msp-mac-mini-readiness] ${error.message}`);
    process.exitCode = 1;
  });
}
