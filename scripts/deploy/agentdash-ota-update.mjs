#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_HEALTH_TIMEOUT_SEC = 90;
const DEFAULT_HEALTH_INTERVAL_MS = 2_000;

function absolutePath(value) {
  return path.resolve(process.cwd(), value);
}

function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readTextFile(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

function writeJsonFile(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function nowIso() {
  return new Date().toISOString();
}

export function readEnvValue(content, key) {
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*=\\s*(.*)\\s*$`);
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) continue;
    return match[1]?.replace(/^['"]|['"]$/g, "") ?? "";
  }
  return null;
}

export function setEnvValue(content, key, value) {
  const line = `${key}=${value}`;
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*=`);
  let replaced = false;
  const next = lines.map((existing) => {
    if (pattern.test(existing)) {
      replaced = true;
      return line;
    }
    return existing;
  });
  if (!replaced) {
    if (next.length > 0 && next[next.length - 1] !== "") next.push("");
    next.push(line);
  }
  return `${next.join("\n").replace(/\n+$/, "")}\n`;
}

export function normalizeTargetImage({ imageRepo, targetSha, targetImage }) {
  if (targetImage) return targetImage;
  if (!imageRepo) throw new Error("imageRepo is required when targetImage is not provided");
  if (!targetSha) throw new Error("targetSha is required when targetImage is not provided");

  const rawTag = targetSha.startsWith("sha-") ? targetSha : `sha-${targetSha}`;
  const tag = rawTag.toLowerCase();
  if (!/^sha-[0-9a-f]{7,40}$/.test(tag)) {
    throw new Error(`Invalid target SHA/tag: ${targetSha}. Expected a 7-40 character git SHA or sha-<sha> tag.`);
  }
  return `${imageRepo}:${tag}`;
}

export function buildDeploymentPlan(input, state = {}) {
  const stateDir = absolutePath(input.stateDir ?? path.join(os.homedir(), ".agentdash", "deployments"));
  const envFile = absolutePath(input.envFile ?? "agentdash.env");
  const composeFile = absolutePath(input.composeFile ?? "docker/docker-compose.production.yml");
  const envContent = input.envContent ?? readTextFile(envFile);
  const currentEnvImage = readEnvValue(envContent, "AGENTDASH_IMAGE");
  const currentImage = state.currentImage ?? currentEnvImage ?? null;
  const action = input.rollback ? "rollback" : "update";

  let targetImage;
  if (action === "rollback") {
    targetImage = input.rollbackToImage ?? state.previousImage;
    if (!targetImage) {
      throw new Error("Rollback requested, but no previous image was found. Pass --rollback-to-image or run after a successful update.");
    }
  } else {
    targetImage = normalizeTargetImage(input);
  }

  const previousImage = currentImage && currentImage !== targetImage ? currentImage : null;
  const receiptDir = path.join(stateDir, "receipts");
  const receiptPath = path.join(receiptDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${action}.json`);
  const baseUrl = input.baseUrl ?? process.env.PAPERCLIP_PUBLIC_URL ?? "http://127.0.0.1:3100";
  const healthPath = input.healthPath ?? "/api/health";
  const service = input.service ?? "server";

  return {
    action,
    targetImage,
    previousImage,
    imageRepo: input.imageRepo ?? null,
    composeFile,
    envFile,
    stateDir,
    statePath: path.join(stateDir, "state.json"),
    receiptPath,
    baseUrl,
    healthUrl: new URL(healthPath, baseUrl).toString(),
    healthTimeoutSec: input.healthTimeoutSec ?? DEFAULT_HEALTH_TIMEOUT_SEC,
    healthIntervalMs: input.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
    service,
    skipBackup: Boolean(input.skipBackup),
    hasBackupCommand: Boolean(input.backupCommand),
    hasReadinessCommand: Boolean(input.readinessCommand),
    commands: {
      inspectImage: ["docker", ["buildx", "imagetools", "inspect", targetImage]],
      composePull: ["docker", ["compose", "--env-file", envFile, "-f", composeFile, "pull", service]],
      composeUp: ["docker", ["compose", "--env-file", envFile, "-f", composeFile, "up", "-d", service]],
    },
  };
}

function runCommand(command, args, label) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function runShell(command, label) {
  const result = spawnSync(command, { shell: true, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

async function waitForHealth(url, timeoutSec, intervalMs) {
  const deadline = Date.now() + timeoutSec * 1_000;
  let lastError = null;

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (response.ok && (!parsed || parsed.status === "ok")) {
        return { ok: true, status: response.status, body: parsed ?? text };
      }
      lastError = new Error(`health returned ${response.status}: ${text.slice(0, 300)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Health check did not pass before timeout: ${lastError?.message ?? "unknown error"}`);
}

export async function runDeployment(input) {
  const stateDir = absolutePath(input.stateDir ?? path.join(os.homedir(), ".agentdash", "deployments"));
  const statePath = path.join(stateDir, "state.json");
  const existingState = input.state ?? readJsonFile(statePath, {});
  const plan = buildDeploymentPlan(input, existingState);

  if (input.dryRun) {
    return {
      dryRun: true,
      plan,
      state: existingState,
    };
  }

  if (!plan.skipBackup && !input.backupCommand) {
    throw new Error("Refusing to deploy without a backup. Pass --backup-command '<command>' or --skip-backup for an explicit exception.");
  }

  const startedAt = nowIso();
  const checks = [];

  runCommand(...plan.commands.inspectImage, "image inspection");
  checks.push({ name: "image_exists", status: "passed", completedAt: nowIso() });

  if (!plan.skipBackup) {
    runShell(input.backupCommand, "backup command");
    checks.push({ name: "backup", status: "passed", completedAt: nowIso() });
  } else {
    checks.push({ name: "backup", status: "skipped", completedAt: nowIso(), reason: "operator passed --skip-backup" });
  }

  const envContent = readTextFile(plan.envFile);
  writeFileSync(plan.envFile, setEnvValue(envContent, "AGENTDASH_IMAGE", plan.targetImage), { mode: 0o600 });
  checks.push({ name: "pin_image", status: "passed", completedAt: nowIso() });

  runCommand(...plan.commands.composePull, "docker compose pull");
  checks.push({ name: "compose_pull", status: "passed", completedAt: nowIso() });

  runCommand(...plan.commands.composeUp, "docker compose up");
  checks.push({ name: "compose_up", status: "passed", completedAt: nowIso() });

  const health = await waitForHealth(plan.healthUrl, plan.healthTimeoutSec, plan.healthIntervalMs);
  checks.push({ name: "health", status: "passed", completedAt: nowIso(), result: health });

  if (input.readinessCommand) {
    runShell(input.readinessCommand, "readiness command");
    checks.push({ name: "readiness", status: "passed", completedAt: nowIso() });
  }

  const completedAt = nowIso();
  const receipt = {
    version: 1,
    action: plan.action,
    operator: input.operator ?? process.env.USER ?? "unknown",
    startedAt,
    completedAt,
    composeFile: plan.composeFile,
    envFile: plan.envFile,
    service: plan.service,
    baseUrl: plan.baseUrl,
    healthUrl: plan.healthUrl,
    previousImage: plan.previousImage,
    targetImage: plan.targetImage,
    backupCommandConfigured: Boolean(input.backupCommand),
    readinessCommandConfigured: Boolean(input.readinessCommand),
    skipBackup: plan.skipBackup,
    checks,
  };

  writeJsonFile(plan.receiptPath, receipt);
  writeJsonFile(plan.statePath, {
    version: 1,
    currentImage: plan.targetImage,
    previousImage: plan.previousImage ?? existingState.previousImage ?? null,
    lastReceiptPath: plan.receiptPath,
    updatedAt: completedAt,
  });

  return { dryRun: false, plan, receipt };
}

function printHelp() {
  console.log(`Usage:
  node scripts/deploy/agentdash-ota-update.mjs --target-sha <git-sha> --image-repo ghcr.io/<owner>/<repo> [options]
  node scripts/deploy/agentdash-ota-update.mjs --rollback [options]

Options:
  --target-sha <sha>          Git SHA or sha-<sha> Docker tag to deploy.
  --target-image <image>      Full image reference. Overrides --target-sha/--image-repo.
  --image-repo <repo>         Image repository, for example ghcr.io/acme/agentdash.
  --compose-file <path>       Compose file to run. Default: docker/docker-compose.production.yml.
  --runtime-env-file <path>   Env file that contains AGENTDASH_IMAGE and runtime env.
  --state-dir <path>          Deployment state/receipt directory. Default: ~/.agentdash/deployments.
  --backup-command <command>  Command to run before changing the pinned image.
  --readiness-command <cmd>   Optional readiness proof command after health passes.
  --base-url <url>            Instance URL for /api/health. Default: PAPERCLIP_PUBLIC_URL or localhost.
  --service <name>            Compose service name. Default: server.
  --rollback                  Deploy the previous image from state.
  --rollback-to-image <image> Explicit image to deploy for rollback.
  --skip-backup               Explicitly deploy without running a backup command.
  --dry-run                   Build and print the plan without changing host state.
  --help                      Show this help.
`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "target-sha": { type: "string" },
      "target-image": { type: "string" },
      "image-repo": { type: "string" },
      "compose-file": { type: "string" },
      "runtime-env-file": { type: "string" },
      "state-dir": { type: "string" },
      "backup-command": { type: "string" },
      "readiness-command": { type: "string" },
      "base-url": { type: "string" },
      "health-path": { type: "string" },
      "health-timeout-sec": { type: "string" },
      service: { type: "string" },
      operator: { type: "string" },
      rollback: { type: "boolean" },
      "rollback-to-image": { type: "string" },
      "skip-backup": { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    printHelp();
    return;
  }

  const result = await runDeployment({
    targetSha: values["target-sha"],
    targetImage: values["target-image"],
    imageRepo: values["image-repo"] ?? process.env.AGENTDASH_IMAGE_REPO,
    composeFile: values["compose-file"] ?? process.env.AGENTDASH_DEPLOY_COMPOSE_FILE,
    envFile: values["runtime-env-file"] ?? process.env.AGENTDASH_DEPLOY_ENV_FILE,
    stateDir: values["state-dir"] ?? process.env.AGENTDASH_DEPLOY_STATE_DIR,
    backupCommand: values["backup-command"] ?? process.env.AGENTDASH_BACKUP_COMMAND,
    readinessCommand: values["readiness-command"] ?? process.env.AGENTDASH_READINESS_COMMAND,
    baseUrl: values["base-url"] ?? process.env.PAPERCLIP_PUBLIC_URL,
    healthPath: values["health-path"],
    healthTimeoutSec: values["health-timeout-sec"] ? Number(values["health-timeout-sec"]) : undefined,
    service: values.service,
    operator: values.operator,
    rollback: values.rollback,
    rollbackToImage: values["rollback-to-image"],
    skipBackup: values["skip-backup"],
    dryRun: values["dry-run"],
  });

  console.log(JSON.stringify(result.dryRun ? result.plan : result.receipt, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[agentdash-ota-update] ${error.message}`);
    process.exitCode = 1;
  });
}
