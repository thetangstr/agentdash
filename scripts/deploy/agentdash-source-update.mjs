#!/usr/bin/env node
/**
 * Over-the-air updates for a source deployment.
 *
 * `agentdash-ota-update.mjs` beside this file updates a Docker deployment by
 * pinning an image. The MKThink Mac Mini is not that: it runs the repository
 * itself, through `tsx`, under launchd. Updating it has meant a person with a
 * terminal running `git pull` — which is how a customer's box quietly drifts
 * from `main`, and how every fix waits on someone's evening.
 *
 * This does the same job for that shape, with the same discipline as its
 * Docker sibling: plan, back up, apply, prove health, roll back on failure,
 * leave a receipt. GitHub is the source of truth — the target is whatever the
 * tracked branch points at, never local state.
 *
 * What it deliberately does NOT do yet, and what the OTA plan
 * (doc/plans/2026-08-18-ota-updater-scope.md) still wants: signed release
 * artifacts and atomic release directories. A git checkout can be half-updated
 * in a way an immutable release directory cannot, so the mitigation here is
 * ordering — fetch and verify before touching the working tree, refuse to run
 * against a dirty tree, and roll back to the exact previous SHA on any failure.
 */
import { spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_HEALTH_TIMEOUT_SEC = 120;
const DEFAULT_HEALTH_INTERVAL_MS = 2_000;
const DEFAULT_REPO_DIR = path.join(os.homedir(), "agentdash");
const DEFAULT_PORT = 3102;

function absolutePath(value) {
  return path.resolve(process.cwd(), value);
}

function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Decide what this run should do, before it does anything.
 *
 * Separated from execution so the decision is testable without a repository,
 * a network, or a running server — the same split the Docker updater uses.
 */
/**
 * The branch a machine is allowed to run, if it says so.
 *
 * A lock file next to the deployment state, holding one branch name. When it is
 * present, this updater will only deploy that branch and refuses anything else.
 *
 * It exists because the interesting branches are the dangerous ones. `staging`
 * is where half-finished work goes to be driven on a test instance, and the
 * updater takes `--branch`, so one flag on the wrong terminal puts a candidate
 * onto a customer's machine. That is a typo away at 2am, and the machine is the
 * only thing that knows which kind of machine it is.
 *
 * Absent on a test instance, so nothing changes there — the lock is opt-in per
 * machine, and the machine that needs it is the one running production.
 */
export function readDeployBranchLock(stateDir, env = process.env) {
  const override = env.AGENTDASH_DEPLOY_BRANCH_LOCK;
  if (typeof override === "string" && override.trim()) return override.trim();
  const lockPath = path.join(stateDir, "allowed-branch");
  try {
    const contents = readFileSync(lockPath, "utf8").trim();
    return contents.length > 0 ? contents : null;
  } catch {
    return null;
  }
}

/**
 * Refuse a deployment the machine has not been told to accept.
 *
 * Thrown rather than warned. A warning on a deploy script is read after the
 * deploy, and by then the customer's instance is running a candidate.
 */
export function assertBranchAllowed(branch, allowedBranch) {
  if (!allowedBranch || branch === allowedBranch) return;
  throw new Error(
    `This machine is locked to the "${allowedBranch}" branch and refuses to deploy "${branch}".\n` +
      "That lock is what stops a test branch reaching a production instance.\n" +
      "If this really is a machine that should track another branch, change the branch " +
      "named in the lock file rather than passing --branch past it.",
  );
}

export function buildUpdatePlan(input, state = {}) {
  const repoDir = absolutePath(input.repoDir ?? DEFAULT_REPO_DIR);
  const stateDir = absolutePath(
    input.stateDir ?? path.join(os.homedir(), ".agentdash", "deployments"),
  );
  const remote = input.remote ?? "origin";
  const branch = input.branch ?? "main";
  // Checked while deciding, not while executing: the plan is what `--check`
  // prints, so a locked machine says no before anybody runs the real thing.
  assertBranchAllowed(branch, input.allowedBranch ?? readDeployBranchLock(stateDir));
  const currentSha = input.currentSha ?? null;
  const previousSha = state.currentSha ?? null;

  let action = "update";
  let targetSha = input.targetSha ?? input.remoteSha ?? null;

  if (input.rollback) {
    action = "rollback";
    targetSha = input.rollbackToSha ?? state.previousSha ?? null;
    if (!targetSha) {
      throw new Error(
        "No previous deployment recorded, so there is nothing to roll back to. Pass --rollback-to-sha <sha>.",
      );
    }
  } else if (!targetSha) {
    throw new Error("No target commit resolved. Pass --target-sha <sha> or allow the remote to be fetched.");
  } else if (currentSha && currentSha === targetSha && !input.force) {
    // Already there. Saying so is the whole answer; pretending to deploy would
    // restart a healthy server for nothing.
    action = "noop";
  }

  const receiptDir = path.join(stateDir, "receipts");
  const receiptPath = path.join(
    receiptDir,
    `${nowIso().replace(/[:.]/g, "-")}-source-${action}.json`,
  );

  return {
    action,
    repoDir,
    remote,
    branch,
    currentSha,
    previousSha,
    targetSha,
    stateDir,
    statePath: path.join(stateDir, "source-state.json"),
    receiptDir,
    receiptPath,
    healthUrl: `${(input.baseUrl ?? `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/+$/, "")}/api/health`,
    healthTimeoutSec: input.healthTimeoutSec ?? DEFAULT_HEALTH_TIMEOUT_SEC,
    healthIntervalMs: input.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS,
    skipBackup: Boolean(input.skipBackup),
    allowDirty: Boolean(input.allowDirty),
    restartCommand: input.restartCommand ?? defaultRestartCommand(input.port ?? DEFAULT_PORT),
  };
}

/**
 * How to restart a launchd-supervised source deployment without a password.
 *
 * `launchctl kickstart` on a system daemon needs root, which a scheduled job or
 * an SSH session does not have. The daemons carry `KeepAlive => true`, so
 * killing the listener and its parent is a complete restart: launchd respawns
 * in about ten seconds. Killing only the listener leaves the pnpm wrapper alive
 * and launchd believing the job still runs, which is why the parent is included.
 */
export function defaultRestartCommand(port) {
  return [
    `pid=$(lsof -nP -iTCP:${port} -sTCP:LISTEN -t | head -1)`,
    'if [ -n "$pid" ]; then kill -9 "$pid" "$(ps -o ppid= -p "$pid" | tr -d " ")" 2>/dev/null || true; fi',
  ].join("; ");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() : "";
    throw new Error(`${options.label ?? command} failed with exit ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return (result.stdout ?? "").trim();
}

function runShell(command, label) {
  const result = spawnSync("/bin/sh", ["-c", command], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
}

function git(repoDir, args, options = {}) {
  return run("git", ["-C", repoDir, ...args], { capture: true, label: `git ${args[0]}`, ...options });
}

/**
 * One health request, over node:http(s) rather than fetch.
 *
 * fetch's undici stack raised `EINVAL setTypeOfService` against loopback on
 * this Node build and macOS version, asynchronously and outside the await — so
 * it crashed the updater instead of counting as a failed attempt. A health
 * check that can kill the process it is meant to verify is worse than no
 * health check, and this path has no such surprise: every failure arrives on
 * the request object as an event.
 */
function requestHealth(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    let request;
    try {
      const target = new URL(url);
      const transport = target.protocol === "https:" ? https : http;
      request = transport.request(
        target,
        {
          method: "GET",
          headers: { accept: "application/json" },
          // The instance serves a certificate for its public hostname; this is
          // a liveness probe from the same machine, not a trust decision.
          rejectUnauthorized: false,
          timeout: timeoutMs,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            finish(resolve, {
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8").slice(0, 500),
            }),
          );
          response.on("error", (error) => finish(reject, error));
        },
      );
    } catch (error) {
      finish(reject, error);
      return;
    }
    request.on("error", (error) => finish(reject, error));
    request.on("timeout", () => {
      request.destroy(new Error("health request timed out"));
    });
    request.end();
  });
}

export async function waitForHealth(url, timeoutSec, intervalMs) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await requestHealth(url, Math.max(intervalMs, 5_000));
      if (response.status >= 200 && response.status < 300) return response;
      lastError = new Error(`health returned ${response.status}: ${response.body.slice(0, 200)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Health check did not pass before timeout: ${lastError?.message ?? "unknown error"}`);
}

/**
 * Move the working tree to a commit and make it runnable.
 *
 * Detached, not "checkout the branch and fast-forward". A rollback goes
 * BACKWARDS, and merging an older commit into the branch is not a
 * fast-forward, so the branch-based version could only ever move one
 * direction — it would have failed the first time it was needed, which is the
 * worst moment to discover it. A deployment does not need to be on a branch;
 * it needs to be at a commit, and detaching also keeps the updater from moving
 * anybody's branch pointer underneath them.
 */
function applyRevision(plan, sha, checks, phase) {
  git(plan.repoDir, ["checkout", "--quiet", "--detach", sha]);
  checks.push({ name: `${phase}_checkout`, status: "passed", sha, completedAt: nowIso() });

  /**
   * Non-interactive, and said twice on purpose.
   *
   * A branch move can leave pnpm wanting a full reinstall, at which point it
   * asks "The modules directories will be removed and reinstalled from
   * scratch. Proceed? (Y/n)" and waits. Under launchd there is nobody to
   * answer, so the update hangs forever holding a half-installed tree —
   * observed on the Mini, killed by hand after ten minutes. `CI=1` puts pnpm in
   * non-interactive mode and the explicit flag answers the one question that
   * mode still leaves open.
   */
  run(
    "pnpm",
    ["install", "--no-frozen-lockfile", "--config.confirm-modules-purge=false"],
    { cwd: plan.repoDir, label: "pnpm install", env: { ...process.env, CI: "1" } },
  );
  checks.push({ name: `${phase}_install`, status: "passed", completedAt: nowIso() });

  run("pnpm", ["--filter", "./packages/**", "build"], { cwd: plan.repoDir, label: "packages build" });
  run("pnpm", ["--filter", "@paperclipai/ui", "build"], { cwd: plan.repoDir, label: "ui build" });
  checks.push({ name: `${phase}_build`, status: "passed", completedAt: nowIso() });

  runShell(plan.restartCommand, "restart");
  checks.push({ name: `${phase}_restart`, status: "passed", completedAt: nowIso() });
}

export async function runUpdate(input) {
  const repoDir = absolutePath(input.repoDir ?? DEFAULT_REPO_DIR);
  const stateDir = absolutePath(
    input.stateDir ?? path.join(os.homedir(), ".agentdash", "deployments"),
  );
  const statePath = path.join(stateDir, "source-state.json");
  const state = input.state ?? readJsonFile(statePath, {});

  // GitHub is the source of truth: ask it before deciding anything.
  if (!input.targetSha && !input.rollback) {
    git(repoDir, ["fetch", "--quiet", input.remote ?? "origin", input.branch ?? "main"]);
  }
  const currentSha = input.currentSha ?? git(repoDir, ["rev-parse", "HEAD"]);
  const remoteSha =
    input.remoteSha
    ?? (input.rollback ? null : git(repoDir, ["rev-parse", `${input.remote ?? "origin"}/${input.branch ?? "main"}`]));

  const plan = buildUpdatePlan({ ...input, repoDir, stateDir, currentSha, remoteSha }, state);

  if (input.checkOnly || input.dryRun) {
    return { checkOnly: Boolean(input.checkOnly), dryRun: Boolean(input.dryRun), plan, state };
  }

  if (plan.action === "noop") {
    return { plan, state, upToDate: true };
  }

  if (!plan.allowDirty) {
    const dirty = git(repoDir, ["status", "--porcelain"]);
    if (dirty) {
      throw new Error(
        "Refusing to update with local changes in the working tree. Commit, stash, or pass --allow-dirty:\n"
          + dirty.split("\n").slice(0, 10).join("\n"),
      );
    }
  }

  if (!plan.skipBackup && !input.backupCommand) {
    throw new Error(
      "Refusing to update without a backup. Pass --backup-command '<command>', or --skip-backup to say so out loud.",
    );
  }

  const startedAt = nowIso();
  const checks = [];

  if (!plan.skipBackup) {
    runShell(input.backupCommand, "backup command");
    checks.push({ name: "backup", status: "passed", completedAt: nowIso() });
  } else {
    checks.push({ name: "backup", status: "skipped", reason: "operator passed --skip-backup", completedAt: nowIso() });
  }

  let rolledBackTo = null;
  let health = null;
  try {
    applyRevision(plan, plan.targetSha, checks, "apply");
    health = await waitForHealth(plan.healthUrl, plan.healthTimeoutSec, plan.healthIntervalMs);
    checks.push({ name: "health", status: "passed", result: health, completedAt: nowIso() });
  } catch (error) {
    checks.push({ name: "apply", status: "failed", error: String(error?.message ?? error), completedAt: nowIso() });
    // The previous commit ran a moment ago, so it is the one thing known to
    // work. Going back to it is the whole point of recording it.
    if (plan.currentSha && plan.currentSha !== plan.targetSha) {
      try {
        applyRevision(plan, plan.currentSha, checks, "rollback");
        health = await waitForHealth(plan.healthUrl, plan.healthTimeoutSec, plan.healthIntervalMs);
        rolledBackTo = plan.currentSha;
        checks.push({ name: "rollback_health", status: "passed", result: health, completedAt: nowIso() });
      } catch (rollbackError) {
        checks.push({
          name: "rollback",
          status: "failed",
          error: String(rollbackError?.message ?? rollbackError),
          completedAt: nowIso(),
        });
      }
    }
    const receipt = {
      version: 1,
      kind: "source",
      action: plan.action,
      outcome: rolledBackTo ? "rolled_back" : "failed",
      operator: input.operator ?? process.env.USER ?? "unknown",
      startedAt,
      completedAt: nowIso(),
      repoDir: plan.repoDir,
      remote: plan.remote,
      branch: plan.branch,
      previousSha: plan.currentSha,
      targetSha: plan.targetSha,
      rolledBackTo,
      healthUrl: plan.healthUrl,
      checks,
    };
    writeJsonFile(plan.receiptPath, receipt);
    throw error;
  }

  const nextState = {
    version: 1,
    kind: "source",
    currentSha: plan.targetSha,
    previousSha: plan.currentSha ?? state.currentSha ?? null,
    repoDir: plan.repoDir,
    remote: plan.remote,
    branch: plan.branch,
    updatedAt: nowIso(),
  };
  writeJsonFile(plan.statePath, nextState);

  // Refresh the copy the scheduled job runs, from the commit just deployed.
  let selfInstalledTo = null;
  if (input.selfInstallPath !== false) {
    const target = input.selfInstallPath
      ?? path.join(os.homedir(), ".agentdash", "bin", "agentdash-source-update.mjs");
    const source = path.join(plan.repoDir, "scripts", "deploy", "agentdash-source-update.mjs");
    try {
      if (existsSync(source)) selfInstalledTo = selfInstall(source, target);
      checks.push({ name: "self_install", status: selfInstalledTo ? "passed" : "skipped", completedAt: nowIso() });
    } catch (error) {
      // Never fail a healthy deployment over its own housekeeping.
      checks.push({
        name: "self_install",
        status: "failed",
        error: String(error?.message ?? error),
        completedAt: nowIso(),
      });
    }
  }

  const receipt = {
    version: 1,
    kind: "source",
    action: plan.action,
    outcome: "succeeded",
    selfInstalledTo,
    operator: input.operator ?? process.env.USER ?? "unknown",
    startedAt,
    completedAt: nowIso(),
    repoDir: plan.repoDir,
    remote: plan.remote,
    branch: plan.branch,
    previousSha: plan.currentSha,
    targetSha: plan.targetSha,
    healthUrl: plan.healthUrl,
    backupCommandConfigured: Boolean(input.backupCommand),
    skipBackup: plan.skipBackup,
    checks,
  };
  writeJsonFile(plan.receiptPath, receipt);

  return { plan, state: nextState, receipt, health };
}

/**
 * Keep a copy of this updater outside the checkout it updates.
 *
 * The updater lives inside the thing it updates, which is the one case the OTA
 * plan calls out as able to strand a customer. It is not hypothetical: the
 * first live rollback attempt died with MODULE_NOT_FOUND, because the update
 * before it had checked out a commit where this file did not exist yet.
 *
 * So the scheduled job runs the installed copy under ~/.agentdash/bin, and a
 * successful update refreshes that copy from the commit it just deployed. A
 * half-finished update can change the repository without taking the tool that
 * repairs it away.
 */
export function selfInstall(sourcePath, targetPath) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
  chmodSync(targetPath, 0o755);
  return targetPath;
}

function usage() {
  process.stdout.write(`Usage:
  node scripts/deploy/agentdash-source-update.mjs [options]
  node scripts/deploy/agentdash-source-update.mjs --check
  node scripts/deploy/agentdash-source-update.mjs --rollback

Updates a source deployment (a git checkout run under launchd) to the tip of
its tracked branch on GitHub, proves health, and rolls back if it cannot.

Options:
  --repo-dir <path>          Checkout to update. Default: ~/agentdash
  --remote <name>            Git remote. Default: origin
  --branch <name>            Branch to track. Default: main
  --target-sha <sha>         Deploy this commit instead of the branch tip.
  --check                    Report current vs available and change nothing.
  --dry-run                  Print the plan and change nothing.
  --rollback                 Return to the previously deployed commit.
  --rollback-to-sha <sha>    Explicit commit for a rollback.
  --backup-command <cmd>     Run before applying. Required unless --skip-backup.
  --skip-backup              Update without a backup, deliberately.
  --allow-dirty              Update even with local changes in the tree.
  --base-url <url>           Instance base URL for /api/health. Default: http://127.0.0.1:3102
  --port <port>              Port used by the default restart command. Default: 3102
  --restart-command <cmd>    Override how the service is restarted.
  --health-timeout <sec>     Health timeout. Default: 120
  --state-dir <path>         State and receipts. Default: ~/.agentdash/deployments
  --force                    Apply even when already at the target commit.
  --self-install-path <path> Where to keep the standalone copy of this updater.
                             Default: ~/.agentdash/bin/agentdash-source-update.mjs
  --no-self-install          Do not refresh that copy.
  --help                     Show this help.
`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "repo-dir": { type: "string" },
      remote: { type: "string" },
      branch: { type: "string" },
      "target-sha": { type: "string" },
      check: { type: "boolean" },
      "dry-run": { type: "boolean" },
      rollback: { type: "boolean" },
      "rollback-to-sha": { type: "string" },
      "backup-command": { type: "string" },
      "skip-backup": { type: "boolean" },
      "allow-dirty": { type: "boolean" },
      "base-url": { type: "string" },
      port: { type: "string" },
      "restart-command": { type: "string" },
      "health-timeout": { type: "string" },
      "state-dir": { type: "string" },
      force: { type: "boolean" },
      "self-install-path": { type: "string" },
      "no-self-install": { type: "boolean" },
      help: { type: "boolean" },
    },
  });

  if (values.help) {
    usage();
    return;
  }

  const result = await runUpdate({
    repoDir: values["repo-dir"],
    remote: values.remote,
    branch: values.branch,
    targetSha: values["target-sha"],
    checkOnly: values.check,
    dryRun: values["dry-run"],
    rollback: values.rollback,
    rollbackToSha: values["rollback-to-sha"],
    backupCommand: values["backup-command"],
    skipBackup: values["skip-backup"],
    allowDirty: values["allow-dirty"],
    baseUrl: values["base-url"] ?? process.env.PAPERCLIP_PUBLIC_URL,
    port: values.port ? Number.parseInt(values.port, 10) : undefined,
    restartCommand: values["restart-command"],
    healthTimeoutSec: values["health-timeout"] ? Number.parseInt(values["health-timeout"], 10) : undefined,
    stateDir: values["state-dir"],
    force: values.force,
    selfInstallPath: values["no-self-install"] ? false : values["self-install-path"],
  });

  if (result.checkOnly || result.dryRun) {
    const { plan } = result;
    const behind = plan.currentSha !== plan.targetSha;
    process.stdout.write(
      `${JSON.stringify(
        {
          action: plan.action,
          upToDate: !behind,
          current: plan.currentSha,
          available: plan.targetSha,
          branch: `${plan.remote}/${plan.branch}`,
          repoDir: plan.repoDir,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (result.upToDate) {
    process.stdout.write(`Already at ${result.plan.currentSha} — nothing to update.\n`);
    return;
  }

  process.stdout.write(
    `Updated ${result.plan.previousSha ?? "unknown"} -> ${result.plan.targetSha}. Receipt: ${result.plan.receiptPath}\n`,
  );
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("agentdash-source-update.mjs");
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[source-update] ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
