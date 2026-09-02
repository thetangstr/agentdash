#!/usr/bin/env node
// Phase 1: applying a release.
//
// This is the process that acts on a human's approval. It runs OUTSIDE the
// server — launchd invokes it — because a process cannot restart itself and
// then report on how the restart went, and because deploy authority in the web
// tier would make every web vulnerability a code-execution path on a customer's
// machine.
//
// The stage order is the safety property, and it is not arbitrary:
//
//   provenance → approval → compatibility → backup → materialize → switch
//   → restart → health → (rollback on failure) → receipt
//
// Everything that can refuse does so BEFORE anything is mutated. Materializing
// happens before the switch, so a build failure costs a directory and not an
// outage. The switch is a symlink rename, which is atomic — the only
// irreversible-looking step is therefore reversible by doing it again in the
// other direction.
//
// Two deliberate limits, both visible to the operator rather than buried:
//
//   1. NO SIGNATURE VERIFICATION. Provenance here means "this tag is on
//      origin/main and resolves to this commit". Nothing checks who signed it.
//      A compromised push is not detected. This is stated in the receipt.
//   2. MIGRATIONS ARE REFUSED BY DEFAULT. Automatic rollback restores CODE. A
//      release that migrates the database cannot be undone by moving code back,
//      so applying one unattended would mean advertising a rollback that does
//      not exist. `--allow-migrations` exists for an operator who has read the
//      plan and taken a backup they intend to use.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";

import {
  assertAuthoritativeReleaseSource,
  exportRelease as defaultExportRelease,
  buildRelease as defaultBuildRelease,
  sealRelease as defaultSealRelease,
  swapCurrent as defaultSwapCurrent,
  readCurrent as defaultReadCurrent,
  resolveTagCommit,
} from "./ota-release-layout.mjs";

export const DEFAULT_HEALTH_TIMEOUT_SEC = 120;
export const DEFAULT_HEALTH_INTERVAL_MS = 2_000;
export const APPROVAL_FILENAME = "pending-approval.json";
export const CANONICAL_STATE_FILENAME = "deployment-state.json";
export const JOURNAL_SUBPATH = path.join("packages", "db", "src", "migrations", "meta", "_journal.json");

function nowIso() {
  return new Date().toISOString();
}

function readJsonFile(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Ordered migration tags in a checkout, or null when unreadable.
 *
 * Mirrors `server/src/services/ota-migrations.ts`. Null and empty must stay
 * distinct: "no migrations" is safe to apply, "cannot tell" is not.
 */
export function readJournalTags(root) {
  const journal = readJsonFile(path.join(root, JOURNAL_SUBPATH));
  if (!journal || !Array.isArray(journal.entries)) return null;
  return journal.entries.slice().sort((a, b) => a.idx - b.idx).map((entry) => entry.tag);
}

/**
 * Which migrations the target adds relative to what is installed.
 *
 * Compares the two checkouts' journals rather than querying the database. That
 * keeps this script standalone — it is the tool you reach for when a deploy has
 * gone wrong, so it must not need the application's database to be reachable —
 * and it is conservative in the right direction: it assumes the running
 * release's migrations are applied, which is true of any instance that is
 * currently healthy.
 */
export function pendingMigrationsBetween(installedRoot, targetRoot) {
  const installed = readJournalTags(installedRoot);
  const target = readJournalTags(targetRoot);
  if (installed === null || target === null) return null;
  const have = new Set(installed);
  return target.filter((tag) => !have.has(tag));
}

/**
 * The migration policy, in one place.
 *
 * Refusing by default is not conservatism for its own sake: the automatic
 * rollback below restores code only. Applying a migrating release unattended
 * would mean the rollback advertised in the plan is not the rollback that
 * exists.
 */
export function evaluateMigrationPolicy({ pending, allowMigrations }) {
  if (pending === null) {
    return {
      ok: false,
      verdict: "unknown",
      reason:
        "Could not read the migration journal on both sides, so the effect on the database is unknown. Refusing rather than guessing.",
    };
  }
  if (pending.length === 0) {
    return { ok: true, verdict: "compatible", reason: "No pending migrations; rollback is a symlink swap." };
  }
  if (!allowMigrations) {
    return {
      ok: false,
      verdict: "forward_only",
      reason:
        `This release adds ${pending.length} migration(s) (${pending.join(", ")}). `
        + "Automatic rollback restores code only, so it cannot undo them. Re-run with --allow-migrations "
        + "once you have a backup you are willing to restore from, accepting the loss of anything written after the update.",
    };
  }
  return {
    ok: true,
    verdict: "forward_only",
    reason:
      `Applying ${pending.length} migration(s) with --allow-migrations. Rollback of this update requires `
      + "restoring the pre-update backup and will discard data written after it.",
  };
}

/** Does this approval authorize this exact commit? Mirrors the TS planner. */
export function approvalAuthorizes({ approval, tag, commit }) {
  if (!approval) return { ok: false, reason: "No approval on record. A human must approve this release first." };
  if (approval.status !== "approved") return { ok: false, reason: `Approval is '${approval.status}', not 'approved'.` };
  if (approval.commit !== commit) {
    return { ok: false, reason: "The approval is for a different commit than the release being applied." };
  }
  if (approval.tag !== tag) {
    return { ok: false, reason: `The approval is for tag '${approval.tag}', not '${tag}'.` };
  }
  return { ok: true };
}

function git(repoDir, args) {
  const result = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? ""}`);
  return (result.stdout ?? "").trim();
}

/** Is this commit reachable from origin/main? The provenance check. */
export function commitIsOnMain(repoDir, commit) {
  const result = spawnSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", commit, "origin/main"]);
  return result.status === 0;
}

/**
 * Is the target actually forward of what is installed?
 *
 * This exists because of a real observation: on this project every
 * `v2026.827.x` tag resolves to the SAME commit, and the newest tag is behind
 * `origin/main`. So "apply the latest release" is not automatically a move
 * forward, and without this check an update could quietly revert a host — which
 * is precisely the failure the whole release-identity effort was meant to
 * remove. Refusing a non-forward target is cheaper than explaining a silent
 * downgrade afterwards.
 *
 * `equal` is not a downgrade; it is a no-op and is reported as such.
 */
export function assessUpdateDirection(repoDir, installedCommit, targetCommit) {
  if (!installedCommit) {
    return { direction: "unknown", ok: true, reason: "No installed commit on record; treating as a first install." };
  }
  if (installedCommit === targetCommit) {
    return { direction: "same", ok: true, reason: "Target is the commit already installed; nothing to do." };
  }
  const forward = spawnSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", installedCommit, targetCommit]);
  if (forward.status === 0) {
    return { direction: "forward", ok: true, reason: "Target is a descendant of the installed commit." };
  }
  const backward = spawnSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", targetCommit, installedCommit]);
  if (backward.status === 0) {
    return {
      direction: "backward",
      ok: false,
      reason:
        `Refusing to move backwards: ${targetCommit.slice(0, 12)} is an ancestor of the installed `
        + `${installedCommit.slice(0, 12)}. This would revert the instance. Use an explicit rollback instead.`,
    };
  }
  return {
    direction: "diverged",
    ok: false,
    reason:
      `Refusing: the installed commit ${installedCommit.slice(0, 12)} and the target `
      + `${targetCommit.slice(0, 12)} are on diverged histories, so this is neither an update nor a rollback.`,
  };
}

async function defaultCheckHealth(url, timeoutSec, intervalMs, log) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastError = "never responded";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const body = await response.json().catch(() => ({}));
        if (!body.status || body.status === "ok") return { ok: true, detail: `HTTP ${response.status}` };
        lastError = `status=${body.status}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  log?.(`[ota] health did not come back within ${timeoutSec}s (last: ${lastError})`);
  return { ok: false, detail: lastError };
}

function defaultRunCommand(command, label) {
  const result = spawnSync("/bin/sh", ["-c", command], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
}

export const defaultDeps = {
  exportRelease: defaultExportRelease,
  buildRelease: defaultBuildRelease,
  sealRelease: defaultSealRelease,
  swapCurrent: defaultSwapCurrent,
  readCurrent: defaultReadCurrent,
  resolveTagCommit,
  commitIsOnMain,
  checkHealth: defaultCheckHealth,
  runCommand: defaultRunCommand,
  now: nowIso,
  log: (message) => console.log(message),
};

/**
 * Apply one release, or explain why not.
 *
 * Every side effect is injectable so the rollback path can be proven in a test
 * rather than only observed on a host. A rollback that has never been executed
 * is a plan, not a capability, and the one thing this function must actually be
 * able to do is fail safely.
 */
export async function runApply(input, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const checks = [];
  const startedAt = deps.now();
  const stateDir = input.stateDir;
  const record = (name, status, detail) =>
    checks.push({ name, status, detail: detail ?? undefined, completedAt: deps.now() });

  const fail = (stage, message, extra = {}) => {
    record(stage, "failed", message);
    return {
      outcome: "failed",
      error: message,
      failedStage: stage,
      checks,
      startedAt,
      finishedAt: deps.now(),
      signatureVerified: false,
      ...extra,
    };
  };

  // ---- 1. Provenance --------------------------------------------------------
  // Note what this does NOT establish: nothing here verifies a signature. The
  // claim is only that the tag exists on origin/main and resolves to this
  // commit.
  let commit;
  try {
    commit = deps.resolveTagCommit(input.repoDir, input.tag);
  } catch (error) {
    return fail("provenance", `Could not resolve tag '${input.tag}': ${error.message}`);
  }
  const onMain = deps.commitIsOnMain(input.repoDir, commit);
  const source = { remote: "origin", branch: "main", tag: input.tag, commitOnBranch: onMain };
  try {
    assertAuthoritativeReleaseSource(source);
  } catch (error) {
    return fail("provenance", error.message);
  }
  record("provenance", "passed", `${input.tag} -> ${commit} on origin/main (signature NOT verified)`);

  // ---- 1b. Direction --------------------------------------------------------
  const installedState = readJsonFile(path.join(stateDir, CANONICAL_STATE_FILENAME));
  const installedCommit = input.installedCommit ?? installedState?.current?.commit ?? null;
  const direction = assessUpdateDirection(input.repoDir, installedCommit, commit);
  if (!direction.ok) return fail("direction", direction.reason, { direction: direction.direction });
  record("direction", "passed", `${direction.direction}: ${direction.reason}`);

  if (direction.direction === "same" && !input.force) {
    record("noop", "passed", "already on this commit; nothing was changed");
    return {
      outcome: "noop", tag: input.tag, commit, checks, startedAt,
      finishedAt: deps.now(), signatureVerified: false, error: null,
    };
  }

  // ---- 2. Approval ----------------------------------------------------------
  const approval = readJsonFile(path.join(stateDir, APPROVAL_FILENAME));
  if (input.requireApproval !== false) {
    const authorized = approvalAuthorizes({ approval, tag: input.tag, commit });
    if (!authorized.ok) return fail("approval", authorized.reason);
    record("approval", "passed", `approved by ${approval.decidedByUserId} at ${approval.decidedAt}`);
  } else {
    record("approval", "skipped", "approval gate explicitly disabled for this run");
  }

  // ---- 3. Compatibility -----------------------------------------------------
  const installedRoot = input.installedRoot ?? deps.readCurrent(input.releasesRoot) ?? input.repoDir;
  // The target's journal has to be read from the exported tree, so the export
  // happens first — it mutates nothing that is serving.
  let materialized;
  try {
    materialized = deps.exportRelease({
      repoDir: input.repoDir,
      tag: input.tag,
      commit,
      releasesRoot: input.releasesRoot,
    });
  } catch (error) {
    return fail("materialize", `Export failed: ${error.message}`);
  }

  const pending = pendingMigrationsBetween(installedRoot, materialized.releaseDir);
  const policy = evaluateMigrationPolicy({ pending, allowMigrations: Boolean(input.allowMigrations) });
  if (!policy.ok) return fail("compatibility", policy.reason, { pendingMigrations: pending });
  record("compatibility", "passed", policy.reason);

  if (input.dryRun) {
    record("dry_run", "passed", "stopped before backup; nothing was switched");
    return {
      outcome: "noop",
      dryRun: true,
      commit,
      tag: input.tag,
      releaseDir: materialized.releaseDir,
      pendingMigrations: pending,
      checks,
      startedAt,
      finishedAt: deps.now(),
      signatureVerified: false,
      error: null,
    };
  }

  // ---- 4. Backup ------------------------------------------------------------
  // Before anything switches. A backup taken after the switch is a backup of
  // the wrong thing.
  let backupPath = null;
  if (input.backupCommand) {
    try {
      deps.runCommand(input.backupCommand, "backup");
      backupPath = input.backupPathHint ?? "(see backup receipt)";
      record("backup", "passed", backupPath);
    } catch (error) {
      return fail("backup", `Backup failed, refusing to continue: ${error.message}`);
    }
  } else if (input.skipBackup) {
    record("backup", "skipped", "explicitly skipped by operator");
  } else {
    return fail("backup", "No backup command configured. Pass --backup-command or --skip-backup deliberately.");
  }

  // ---- 5. Build -------------------------------------------------------------
  try {
    deps.buildRelease({ releaseDir: materialized.releaseDir });
    deps.sealRelease(materialized.releaseDir);
    record("materialize", "passed", materialized.releaseDir);
  } catch (error) {
    // Nothing has been switched yet, so the running instance is untouched.
    return fail("materialize", `Build failed (nothing was switched): ${error.message}`);
  }

  // ---- 6. Switch ------------------------------------------------------------
  const previousReleaseDir = deps.readCurrent(input.releasesRoot);
  let switched;
  try {
    switched = deps.swapCurrent({ releasesRoot: input.releasesRoot, releaseDir: materialized.releaseDir });
    record("switch", "passed", `current -> ${materialized.releaseDir}`);
  } catch (error) {
    return fail("switch", `Could not switch the current release: ${error.message}`);
  }

  // ---- 7/8. Restart and health ---------------------------------------------
  const healthUrl = `${String(input.baseUrl).replace(/\/+$/, "")}/api/health`;
  const timeoutSec = input.healthTimeoutSec ?? DEFAULT_HEALTH_TIMEOUT_SEC;

  let healthy = { ok: false, detail: "restart not attempted" };
  try {
    deps.runCommand(input.restartCommand, "restart");
    record("restart", "passed");
    healthy = await deps.checkHealth(healthUrl, timeoutSec, input.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS, deps.log);
  } catch (error) {
    healthy = { ok: false, detail: `restart failed: ${error.message}` };
    record("restart", "failed", healthy.detail);
  }

  if (healthy.ok) {
    record("health", "passed", healthy.detail);
    return {
      outcome: "applied",
      tag: input.tag,
      commit,
      releaseDir: materialized.releaseDir,
      previousReleaseDir,
      backupPath,
      pendingMigrations: pending,
      checks,
      startedAt,
      finishedAt: deps.now(),
      signatureVerified: false,
      error: null,
    };
  }

  // ---- 9. Automatic rollback -----------------------------------------------
  // Code only, and that is exactly why step 3 refuses migrations by default.
  record("health", "failed", healthy.detail);
  if (!previousReleaseDir) {
    return fail(
      "rollback",
      `Health did not return (${healthy.detail}) and there is no previous release to fall back to. Manual recovery required.`,
      { releaseDir: materialized.releaseDir, backupPath },
    );
  }

  deps.log?.(`[ota] health failed (${healthy.detail}); rolling back to ${previousReleaseDir}`);
  try {
    deps.swapCurrent({ releasesRoot: input.releasesRoot, releaseDir: previousReleaseDir });
    record("rollback_switch", "passed", `current -> ${previousReleaseDir}`);
    deps.runCommand(input.restartCommand, "restart");
    record("rollback_restart", "passed");
  } catch (error) {
    return fail("rollback", `Rollback failed: ${error.message}`, { backupPath });
  }

  const recovered = await deps.checkHealth(healthUrl, timeoutSec, input.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS, deps.log);
  record("rollback_health", recovered.ok ? "passed" : "failed", recovered.detail);

  return {
    outcome: recovered.ok ? "rolled_back" : "failed",
    tag: input.tag,
    commit,
    releaseDir: previousReleaseDir,
    attemptedReleaseDir: materialized.releaseDir,
    previousReleaseDir,
    backupPath,
    pendingMigrations: pending,
    checks,
    startedAt,
    finishedAt: deps.now(),
    signatureVerified: false,
    error: recovered.ok
      ? `Update failed health (${healthy.detail}); rolled back to the previous release.`
      : `Update failed health (${healthy.detail}) AND rollback did not recover (${recovered.detail}). Manual recovery required.`,
  };
}

/**
 * Persist what happened.
 *
 * The receipt is the artifact the board renders as the outcome, and the
 * canonical state is what the next run reads to decide direction. Both are
 * written even on failure — especially on failure, since a rolled-back update
 * that left no record is indistinguishable from one that never ran.
 *
 * Writes are best-effort and never change the outcome: a full disk should not
 * turn a successful, healthy update into a reported failure.
 */
export function persistOutcome({ stateDir, result, mode = "source-release", channel = "stable" }) {
  const written = { receiptPath: null, statePath: null, error: null };
  try {
    const receiptDir = path.join(stateDir, "receipts");
    mkdirSync(receiptDir, { recursive: true });
    const stamp = String(result.finishedAt).replace(/[:.]/g, "-");
    const receiptPath = path.join(receiptDir, `${stamp}-ota-${result.outcome}.json`);
    const receipt = {
      schemaVersion: 2,
      outcome: result.outcome,
      mode,
      channel,
      to: result.tag ? { tag: result.tag, commit: result.commit ?? null, releaseDir: result.releaseDir ?? null } : null,
      previousReleaseDir: result.previousReleaseDir ?? null,
      attemptedReleaseDir: result.attemptedReleaseDir ?? null,
      approvalId: result.approvalId ?? null,
      backupPath: result.backupPath ?? null,
      pendingMigrations: result.pendingMigrations ?? null,
      // Recorded on every receipt so the limitation is in the audit trail, not
      // only in a document somebody may not have read.
      signatureVerified: false,
      checks: result.checks,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      error: result.error ?? null,
    };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    written.receiptPath = receiptPath;

    // State advances only when the instance actually ended up on the new
    // release. A rollback leaves the recorded current where it already was.
    if (result.outcome === "applied") {
      const statePath = path.join(stateDir, CANONICAL_STATE_FILENAME);
      const previous = readJsonFile(statePath);
      writeFileSync(
        statePath,
        `${JSON.stringify({
          schemaVersion: 2,
          mode,
          channel,
          current: {
            tag: result.tag,
            version: String(result.tag ?? "").replace(/^v/, "") || null,
            commit: result.commit,
            channel,
            releaseDir: result.releaseDir ?? null,
            installedAt: result.finishedAt,
          },
          previous: previous?.current ?? null,
          updatedAt: result.finishedAt,
          lastReceiptPath: receiptPath,
          reconciledFrom: null,
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
      written.statePath = statePath;
    }
  } catch (error) {
    written.error = error instanceof Error ? error.message : String(error);
  }
  return written;
}

function usage() {
  return `Apply an approved AgentDash release.

  --repo-dir <path>          Git clone used only as a source of releases
  --releases-root <path>     Where immutable release directories live
  --state-dir <path>         Deployment state and approval directory
  --tag <vYYYY.MDD.N>        Release tag to apply (must be on origin/main)
  --base-url <url>           Instance base URL for the health check
  --restart-command <cmd>    Shell command that restarts the service
  --backup-command <cmd>     Shell command that takes a database backup
  --skip-backup              Proceed without a backup, deliberately
  --allow-migrations         Permit a release that adds migrations (see below)
  --no-approval              Skip the approval gate (bootstrap only)
  --health-timeout <sec>     Default ${DEFAULT_HEALTH_TIMEOUT_SEC}
  --dry-run                  Stop after compatibility; switch nothing

Signatures are NOT verified. Provenance means the tag is on origin/main.
Migrations are refused unless --allow-migrations, because automatic rollback
restores code and cannot undo a migration.`;
}

export async function main(argv = process.argv) {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      "repo-dir": { type: "string" },
      "releases-root": { type: "string" },
      "state-dir": { type: "string" },
      tag: { type: "string" },
      "base-url": { type: "string" },
      "restart-command": { type: "string" },
      "backup-command": { type: "string" },
      "backup-path-hint": { type: "string" },
      "skip-backup": { type: "boolean" },
      "allow-migrations": { type: "boolean" },
      "no-approval": { type: "boolean" },
      "health-timeout": { type: "string" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });

  if (values.help || !values.tag) {
    console.log(usage());
    return values.help ? 0 : 1;
  }

  const home = os.homedir();
  const result = await runApply({
    repoDir: values["repo-dir"] ?? path.join(home, "agentdash"),
    releasesRoot: values["releases-root"] ?? path.join(home, ".agentdash", "releases"),
    stateDir: values["state-dir"] ?? path.join(home, ".agentdash", "deployments"),
    tag: values.tag,
    baseUrl: values["base-url"] ?? "http://127.0.0.1:3102",
    restartCommand: values["restart-command"],
    backupCommand: values["backup-command"],
    backupPathHint: values["backup-path-hint"],
    skipBackup: Boolean(values["skip-backup"]),
    allowMigrations: Boolean(values["allow-migrations"]),
    requireApproval: !values["no-approval"],
    healthTimeoutSec: values["health-timeout"] ? Number(values["health-timeout"]) : undefined,
    dryRun: Boolean(values["dry-run"]),
    force: Boolean(values.force),
  });

  const persisted = persistOutcome({
    stateDir: values["state-dir"] ?? path.join(home, ".agentdash", "deployments"),
    result,
  });
  console.log(JSON.stringify({ ...result, persisted }, null, 2));
  return result.outcome === "applied" || result.outcome === "noop" ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}

export default { runApply, persistOutcome, assessUpdateDirection, evaluateMigrationPolicy, pendingMigrationsBetween, approvalAuthorizes, readJournalTags };
