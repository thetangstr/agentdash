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
//   provenance → approval → restart command → compatibility
//   → served-release check → backup → materialize → switch → restart
//   → health (ok AND serving the new commit)
//   → (rollback on failure | refresh the updater copies and prune on success)
//   → receipt, consuming the approval once the apply completed
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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  DEFAULT_KEEP_RELEASES,
  assertAuthoritativeReleaseSource,
  compareReleaseTags,
  exportRelease as defaultExportRelease,
  buildRelease as defaultBuildRelease,
  sealRelease as defaultSealRelease,
  writeReleaseMarker as defaultWriteReleaseMarker,
  readReleaseMarker as defaultReadReleaseMarker,
  removeReleaseDir as defaultRemoveReleaseDir,
  swapCurrent as defaultSwapCurrent,
  readCurrent as defaultReadCurrent,
  pruneReleases as defaultPruneReleases,
  releasesInUse as defaultReleasesInUse,
  releasesInPlists as defaultReleasesInPlists,
  PRUNE_CONFIRM_THRESHOLD,
  resolveTagCommit,
  isReleaseTag,
} from "./ota-release-layout.mjs";

export const DEFAULT_BASE_URL = "http://127.0.0.1:3102";
export const DEFAULT_HEALTH_TIMEOUT_SEC = 120;
export const DEFAULT_HEALTH_INTERVAL_MS = 2_000;
export const APPROVAL_FILENAME = "pending-approval.json";
export const CANONICAL_STATE_FILENAME = "deployment-state.json";
export const LEGACY_SOURCE_STATE_FILENAME = "source-state.json";
export const AVAILABLE_RELEASE_FILENAME = "available-release.json";
export const GIT_FETCH_TIMEOUT_MS = 180_000;
export const GH_CLI_TIMEOUT_MS = 30_000;
export const MAX_COMMIT_SUBJECTS = 20;
export const JOURNAL_SUBPATH = path.join("packages", "db", "src", "migrations", "meta", "_journal.json");
const JOURNAL_GIT_PATH = "packages/db/src/migrations/meta/_journal.json";
const MIGRATIONS_GIT_DIR = "packages/db/src/migrations";

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

/**
 * Does this approval authorize this exact commit? Mirrors the TS planner.
 *
 * An approval is single-use: a completed apply or rollback moves it out of
 * `pending-approval.json` (see consumeApproval), so it cannot authorize the
 * same release again later. `consumedAt` is refused here too, as a second
 * line for a file that was restored by hand. `expiresAt` is optional; when
 * present it must parse and be in the future.
 */
export function approvalAuthorizes({ approval, tag, commit, now = Date.now() }) {
  if (!approval) return { ok: false, reason: "No approval on record. A human must approve this release first." };
  if (approval.status !== "approved") return { ok: false, reason: `Approval is '${approval.status}', not 'approved'.` };
  if (approval.consumedAt) {
    return { ok: false, reason: `This approval was already used at ${approval.consumedAt}. Approvals are single-use; approve again.` };
  }
  if (approval.expiresAt !== undefined && approval.expiresAt !== null) {
    const expires = Date.parse(String(approval.expiresAt));
    if (!Number.isFinite(expires)) {
      return { ok: false, reason: `The approval's expiresAt '${approval.expiresAt}' is not a date. Refusing rather than guessing.` };
    }
    const nowMs = typeof now === "number" ? now : Date.parse(String(now));
    if (nowMs >= expires) {
      return { ok: false, reason: `The approval expired at ${approval.expiresAt}. Approve again.` };
    }
  }
  if (approval.commit !== commit) {
    return { ok: false, reason: "The approval is for a different commit than the release being applied." };
  }
  if (approval.tag !== tag) {
    return { ok: false, reason: `The approval is for tag '${approval.tag}', not '${tag}'.` };
  }
  return { ok: true };
}

/** Where used approvals go: out of the path the apply reads, kept for the audit trail. */
export const USED_APPROVALS_DIRNAME = "used-approvals";

/**
 * Make an approval single-use.
 *
 * Called after the receipt of an apply that completed: `applied`, or
 * `rolled_back` (the approval was acted on; the release was tried and
 * refused by health). The file is moved, never rewritten in place, so
 * `pending-approval.json` keeps exactly the shape the board writes and reads,
 * and the next run finds no approval rather than a reusable one. The moved
 * copy carries `consumedAt`, `consumedByReceipt` and `consumedOutcome`.
 *
 * Only the approval that was checked is consumed: if the file now holds a
 * different approval (someone approved a newer release mid-apply), it is left
 * alone and the result says so.
 */
export function consumeApproval({ stateDir, approval, receiptPath, outcome, now = nowIso() }) {
  const approvalPath = path.join(stateDir, APPROVAL_FILENAME);
  const onDisk = readJsonFile(approvalPath);
  if (!onDisk) return { consumed: false, detail: "no approval file to consume" };
  if (onDisk.id !== approval?.id || onDisk.tag !== approval?.tag || onDisk.commit !== approval?.commit) {
    return { consumed: false, detail: "the approval file changed during the apply; left as it is" };
  }
  const usedDir = path.join(stateDir, USED_APPROVALS_DIRNAME);
  mkdirSync(usedDir, { recursive: true });
  const receiptName = receiptPath ? path.basename(receiptPath, ".json") : `${String(now).replace(/[:.]/g, "-")}-no-receipt`;
  const safeId = String(onDisk.id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  const usedPath = path.join(usedDir, `${receiptName}-${safeId}.json`);
  // One atomic rename takes the approval out of the path the gate reads; only
  // then is the moved copy annotated. A crash between the two leaves an
  // unannotated record, never a reusable approval.
  renameSync(approvalPath, usedPath);
  try {
    const temp = `${usedPath}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      `${JSON.stringify({ ...onDisk, consumedAt: now, consumedByReceipt: receiptPath ?? null, consumedOutcome: outcome }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temp, usedPath);
  } catch (error) {
    return { consumed: true, detail: `moved to ${usedPath} (not annotated: ${error.message})`, path: usedPath };
  }
  return { consumed: true, detail: `moved to ${usedPath}`, path: usedPath };
}

function git(repoDir, args, timeoutMs = 0) {
  const result = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    timeout: timeoutMs || undefined,
  });
  if (result.error) throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
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

export const DEFAULT_SERVICE_LABEL = "com.agentdash.mkboard.server";

/**
 * Processes the default restart refuses to kill, whatever tree they appear in.
 * Each has been, or would be, the "ancestor" of a server started by hand or a
 * port someone pointed --base-url at: a terminal, a multiplexer, an SSH
 * session, the proxy in front of the server, or launchd itself.
 */
const NEVER_KILL = /^(Terminal|iTerm2|tmux|screen|sshd|sshd-session|login|launchd|caddy|WindowServer)$/i;

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Which restart this apply will use, or why there is none.
 *
 * Settled before anything is exported or backed up, so a run that could never
 * restart the service refuses up front — including in --dry-run — instead of
 * switching `current`, failing the restart, and rolling back.
 *
 * An explicit --restart-command is run as given. Otherwise the restart is the
 * verified launchd restart (see planServiceRestart), on the listener port from
 * `--port` or the explicit port of a loopback `--base-url`.
 */
export function resolveRestartCommand({ restartCommand, port, baseUrl, serviceLabel }) {
  if (restartCommand !== undefined && restartCommand !== null) {
    if (typeof restartCommand !== "string" || !restartCommand.trim()) {
      return { ok: false, reason: "--restart-command was given but is empty." };
    }
    return { ok: true, kind: "command", command: restartCommand, detail: "--restart-command as given" };
  }
  let listenerPort = port;
  let from = "--port";
  if (listenerPort === undefined || listenerPort === null || listenerPort === "") {
    let url;
    try {
      url = new URL(String(baseUrl ?? DEFAULT_BASE_URL));
    } catch {
      return { ok: false, reason: `No --restart-command, and --base-url '${baseUrl}' is not a URL to derive one from.` };
    }
    if (!LOOPBACK_HOSTNAMES.has(url.hostname) || !url.port) {
      return {
        ok: false,
        reason:
          `No --restart-command, and --base-url ${url.origin} does not name a local listener port (it needs a loopback host `
          + "and an explicit port). Pass --port <server port> or --restart-command.",
      };
    }
    listenerPort = url.port;
    from = "--base-url";
  }
  const n = Number(listenerPort);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return { ok: false, reason: `No --restart-command, and ${from} gives '${listenerPort}', which is not a port.` };
  }
  return { ok: true, kind: "service", port: n, label: serviceLabel || DEFAULT_SERVICE_LABEL, from };
}

/** The pid of a running launchd job from `launchctl print` output, or null. */
export function parseLaunchctlPid(output) {
  const match = /^\s*pid = (\d+)\s*$/m.exec(output ?? "");
  return match ? Number(match[1]) : null;
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
  if (result.error) return { ok: false, stdout: "", error: result.error.message };
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? "", error: (result.stderr ?? "").trim() };
}

/**
 * What the default restart reads from the machine. Injectable so the
 * verification can be tested on invented process trees; nothing in a test
 * inspects or signals a real process.
 */
export const defaultProcessProbe = {
  /** Pids listening on a TCP port, or null when `lsof` cannot answer. */
  listeners(port) {
    const out = capture("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    // lsof exits 1 with no output when nothing listens; that is an answer, not a failure.
    if (!out.ok && (out.stdout.trim() || out.status !== 1)) return null;
    return [...new Set(out.stdout.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0))];
  },
  parentOf(pid) {
    const out = capture("ps", ["-o", "ppid=", "-p", String(pid)]);
    const n = Number(out.stdout.trim());
    return out.ok && Number.isInteger(n) ? n : null;
  },
  commandOf(pid) {
    const out = capture("ps", ["-o", "comm=", "-p", String(pid)]);
    return out.ok ? out.stdout.trim() : "";
  },
  /**
   * The job as launchd reports it, from the system domain first and then the
   * user's GUI domain — whichever the service was installed in. `launchctl
   * print` is readable without root.
   */
  launchdJob(label) {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const targets = [`system/${label}`, ...(uid === null ? [] : [`gui/${uid}/${label}`])];
    for (const target of targets) {
      const out = capture("launchctl", ["print", target]);
      if (out.ok) return { target, pid: parseLaunchctlPid(out.stdout) };
    }
    return null;
  },
};

/**
 * Work out exactly which processes the default restart would kill, or refuse.
 *
 * `launchctl kickstart -k system/...` needs root, which neither the scheduled
 * job nor an SSH session has. The services carry `KeepAlive`, so killing the
 * server's process chain is a complete restart: launchd sees the job exit and
 * starts it again from `releases/current`. The hand-written recipe for this
 * had no idea WHAT it was killing:
 * it walked from whatever listened on the port up to pid 1. For a server
 * started by hand that walk reaches the terminal or the tmux server; for
 * `--base-url` on Caddy's port it kills Caddy, the old server keeps answering
 * health, and the receipt says "applied".
 *
 * So the chain is verified against launchd before anything is killed:
 *   - the service's launchd job must be loaded and running, with a pid;
 *   - every listener on the port must descend from that pid;
 *   - the job's pid must be a direct child of launchd (pid 1);
 *   - nothing in the kill list may be a terminal, multiplexer, SSH session,
 *     proxy or launchd itself.
 * The kill list is the listener up to and including the job's own pid, and
 * never anything above it. Any doubt is a refusal.
 */
export function planServiceRestart({ port, label, probe = defaultProcessProbe }) {
  const job = probe.launchdJob(label);
  if (!job) {
    return { ok: false, reason: `The launchd job ${label} is not loaded (checked system/ and gui/<uid>/), so this restart cannot be verified.` };
  }
  if (!job.pid) {
    return { ok: false, reason: `The launchd job ${job.target} is loaded but not running, so there is nothing verified to restart.`, nothingRunning: true };
  }
  const listeners = probe.listeners(port);
  if (listeners === null) return { ok: false, reason: `Could not list the listeners on port ${port} (lsof failed).` };
  if (listeners.length === 0) {
    return { ok: false, reason: `Nothing listens on port ${port}, so the restart cannot be verified against ${job.target}.`, nothingRunning: true };
  }
  if (probe.parentOf(job.pid) !== 1) {
    return { ok: false, reason: `${job.target} reports pid ${job.pid}, which is not a direct child of launchd; refusing to guess.` };
  }
  const kill = [];
  for (const listener of listeners) {
    const chain = [];
    let pid = listener;
    for (let depth = 0; depth < 64 && pid && pid !== 1; depth += 1) {
      chain.push(pid);
      if (pid === job.pid) break;
      pid = probe.parentOf(pid);
    }
    if (chain[chain.length - 1] !== job.pid) {
      const cmd = path.basename(probe.commandOf(listener) || "?");
      return {
        ok: false,
        reason:
          `The listener on port ${port} is pid ${listener} (${cmd}), which is not part of ${job.target} (pid ${job.pid}). `
          + "Is --base-url pointing at a proxy, or is a server running outside launchd? Nothing was killed.",
      };
    }
    for (const p of chain) if (!kill.includes(p)) kill.push(p);
  }
  const named = kill.map((pid) => ({ pid, command: path.basename(probe.commandOf(pid) || "") }));
  const forbidden = named.find((entry) => NEVER_KILL.test(entry.command));
  if (forbidden) {
    return { ok: false, reason: `Refusing: the chain to ${job.target} includes pid ${forbidden.pid} (${forbidden.command}), which this restart never kills.` };
  }
  return {
    ok: true,
    target: job.target,
    kill,
    detail:
      `kill ${named.map((e) => `${e.pid} (${e.command || "?"})`).join(", ")}: the listener on port ${port} up to ${job.target}; `
      + "KeepAlive restarts it from current",
  };
}

/**
 * The default restart: re-verify (pids change between the preflight and now),
 * then SIGKILL the verified chain. `allowNothingRunning` is for the rollback,
 * where a new release that crashed at boot has left nothing to kill and
 * launchd is already bringing the job back — the health check decides.
 */
export function restartService({ port, label, allowNothingRunning = false, probe = defaultProcessProbe, kill = process.kill }) {
  const plan = planServiceRestart({ port, label, probe });
  if (!plan.ok) {
    if (allowNothingRunning && plan.nothingRunning) return { restarted: false, detail: `${plan.reason} Leaving it to launchd.` };
    throw new Error(plan.reason);
  }
  for (const pid of plan.kill) {
    try {
      kill(pid, "SIGKILL");
    } catch (error) {
      // Already gone is the goal; anything else is a real failure.
      if (error?.code !== "ESRCH") throw error;
    }
  }
  return { restarted: true, detail: plan.detail };
}

/**
 * The files the daily job runs, as installed into `~/.agentdash/bin`.
 *
 * The scheduled wrapper and the updater it calls are copies OUTSIDE any release
 * — an update that changes the updater must not be able to take away the tool
 * that repairs it. Until now those copies were refreshed only from the source
 * clone, which an apply never updates and which drifts behind the serving
 * release: the daily `--check` ran a legacy updater and reported a commit
 * nothing was serving. A healthy apply
 * now installs the copies from the release it just proved.
 */
export const UPDATER_TOOL_FILES = [
  { from: path.join("deploy", "agentdash-update.sh"), to: "agentdash-update.sh" },
  { from: path.join("scripts", "deploy", "ota-apply.mjs"), to: "ota-apply.mjs" },
  { from: path.join("scripts", "deploy", "ota-release-layout.mjs"), to: "ota-release-layout.mjs" },
];

/**
 * The updater's own version. Bump it whenever the updater's behaviour changes
 * (these three files), so that nothing can replace an installed updater with
 * an older one: a rollback to a release that predates a fix must not take
 * that fix away from `~/.agentdash/bin`. `deploy/agentdash-update.sh` reads
 * this line with grep, so keep it a single `export const UPDATER_VERSION = <n>;`
 * line. A file without it is version 0 (everything before this constant).
 *
 * 1: single-use approvals, the served-release check, no updater downgrade.
 */
export const UPDATER_VERSION = 1;

const UPDATER_VERSION_LINE = /^export const UPDATER_VERSION = (\d+);$/m;

/** UPDATER_VERSION declared by an ota-apply.mjs on disk: 0 when absent, null when the file is missing. */
export function readUpdaterVersion(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const match = UPDATER_VERSION_LINE.exec(text);
  return match ? Number(match[1]) : 0;
}

/**
 * Install the updater tools from a release into a bin directory.
 *
 * All or nothing: `ota-apply.mjs` imports `ota-release-layout.mjs`, so a pair
 * from two different releases is a broken tool. Every file is staged beside its
 * destination first and only then renamed into place.
 *
 * Never a downgrade: when the installed `ota-apply.mjs` declares a higher
 * UPDATER_VERSION than the release's, nothing is replaced and the result says
 * so (`skipped: true`).
 */
export function installUpdaterTools({ releaseDir, binDir }) {
  const missing = UPDATER_TOOL_FILES.filter((file) => !existsSync(path.join(releaseDir, file.from)));
  if (missing.length > 0) {
    throw new Error(
      `the release has no ${missing.map((file) => file.from).join(", ")}; ${binDir} was left as it was`,
    );
  }
  const releaseVersion = readUpdaterVersion(path.join(releaseDir, "scripts", "deploy", "ota-apply.mjs")) ?? 0;
  const installedVersion = readUpdaterVersion(path.join(binDir, "ota-apply.mjs"));
  if (installedVersion !== null && installedVersion > releaseVersion) {
    return {
      binDir,
      installed: [],
      skipped: true,
      detail: `kept the installed updater (version ${installedVersion}); the release's is older (version ${releaseVersion})`,
    };
  }
  mkdirSync(binDir, { recursive: true });
  const staged = [];
  try {
    for (const file of UPDATER_TOOL_FILES) {
      const temp = path.join(binDir, `.${file.to}.${process.pid}.tmp`);
      copyFileSync(path.join(releaseDir, file.from), temp);
      // The source is sealed read-only; the installed copy must stay replaceable and executable.
      chmodSync(temp, 0o755);
      staged.push({ temp, dest: path.join(binDir, file.to) });
    }
  } catch (error) {
    for (const { temp } of staged) rmSync(temp, { force: true });
    throw error;
  }
  // Keep the copies being replaced until every rename has landed, so a failure
  // part-way puts the old set back rather than leaving a mixed one.
  const replaced = [];
  try {
    for (const entry of staged) {
      if (existsSync(entry.dest)) {
        const backup = `${entry.dest}.${process.pid}.prev`;
        renameSync(entry.dest, backup);
        entry.backup = backup;
      }
      renameSync(entry.temp, entry.dest);
      replaced.push(entry);
    }
  } catch (error) {
    for (const entry of [...replaced].reverse()) rmSync(entry.dest, { force: true });
    for (const entry of staged) {
      rmSync(entry.temp, { force: true });
      if (entry.backup && existsSync(entry.backup)) renameSync(entry.backup, entry.dest);
    }
    throw error;
  }
  for (const entry of staged) if (entry.backup) rmSync(entry.backup, { force: true });
  return { binDir, installed: UPDATER_TOOL_FILES.map((file) => file.to), version: releaseVersion };
}

/** Do two paths name the same directory? Resolves symlinks when they exist. */
function samePath(a, b) {
  if (!a || !b) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/** The /api/health field that names the commit of the release being served. */
export const SERVED_COMMIT_HEALTH_FIELD = "releaseCommit";

/**
 * Does this release's server report SERVED_COMMIT_HEALTH_FIELD in /api/health?
 * Read from the release's own source, because a release that predates the
 * field can only ever answer health without it.
 */
export function releaseReportsCommit(releaseDir) {
  try {
    const source = readFileSync(path.join(releaseDir, "server", "src", "routes", "health.ts"), "utf8");
    return new RegExp(`\\b${SERVED_COMMIT_HEALTH_FIELD}\\b`).test(source);
  } catch {
    return false;
  }
}

/**
 * Poll /api/health until it is ok — and, when `expectCommit` is given, until
 * it also reports that commit as the release being served.
 *
 * "ok" alone is not proof of an update: a restart that did nothing leaves the
 * old process answering, healthy, from the old release. A body that is ok but
 * names another commit (or none) is therefore not success; polling continues
 * until the deadline, since the old process may still be draining.
 */
export async function defaultCheckHealth(url, timeoutSec, intervalMs, log, { expectCommit = null } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastError = "never responded";
  let servedCommit;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const body = await response.json().catch(() => ({}));
        if (!body.status || body.status === "ok") {
          servedCommit = typeof body[SERVED_COMMIT_HEALTH_FIELD] === "string" ? body[SERVED_COMMIT_HEALTH_FIELD] : undefined;
          if (!expectCommit) return { ok: true, detail: `HTTP ${response.status}`, servedCommit };
          if (servedCommit === expectCommit) {
            return { ok: true, detail: `HTTP ${response.status}, serving ${expectCommit.slice(0, 12)}`, servedCommit };
          }
          lastError = servedCommit
            ? `healthy but serving ${servedCommit.slice(0, 12)}, not ${expectCommit.slice(0, 12)} (the old process is still answering)`
            : `healthy but reports no ${SERVED_COMMIT_HEALTH_FIELD}; expected ${expectCommit.slice(0, 12)} (the old process is still answering)`;
        } else {
          lastError = `status=${body.status}`;
        }
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  log?.(`[ota] health did not come back within ${timeoutSec}s (last: ${lastError})`);
  return { ok: false, detail: lastError, servedCommit };
}

/**
 * What health must report for `releaseDir` to count as served, or why it
 * cannot be checked. Used for the rollback target, which may be an older
 * release that predates the field: there, health ok without it is accepted
 * and the receipt says the served release was not verified.
 */
function servedReleaseExpectation(releaseDir, deps) {
  if (!releaseDir) return { expectCommit: null, reason: "no release directory" };
  const marker = deps.readReleaseMarker(releaseDir);
  if (!marker || marker.complete !== true || typeof marker.commit !== "string") {
    return { expectCommit: null, reason: `${releaseDir} has no completion marker to take its commit from` };
  }
  if (!deps.releaseReportsCommit(releaseDir)) {
    return { expectCommit: null, reason: `${path.basename(releaseDir)} predates ${SERVED_COMMIT_HEALTH_FIELD} in /api/health` };
  }
  return { expectCommit: marker.commit, reason: null };
}

/**
 * Health said ok; does that prove `expectCommit` is served? Also guards a
 * checkHealth that ignored the expectation and reported another commit.
 */
function verifyServed(healthy, expectCommit) {
  if (!healthy.ok || !expectCommit) return healthy;
  if (healthy.servedCommit !== expectCommit) {
    return {
      ok: false,
      detail: healthy.servedCommit
        ? `healthy but serving ${String(healthy.servedCommit).slice(0, 12)}, not ${expectCommit.slice(0, 12)}`
        : `healthy but no ${SERVED_COMMIT_HEALTH_FIELD} reported; expected ${expectCommit.slice(0, 12)}`,
      servedCommit: healthy.servedCommit,
    };
  }
  return healthy;
}

function defaultRunCommand(command, label) {
  const result = spawnSync("/bin/sh", ["-c", command], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
}

export const defaultDeps = {
  exportRelease: defaultExportRelease,
  buildRelease: defaultBuildRelease,
  sealRelease: defaultSealRelease,
  writeReleaseMarker: defaultWriteReleaseMarker,
  readReleaseMarker: defaultReadReleaseMarker,
  removeRelease: defaultRemoveReleaseDir,
  swapCurrent: defaultSwapCurrent,
  readCurrent: defaultReadCurrent,
  pruneReleases: defaultPruneReleases,
  releasesInUse: defaultReleasesInUse,
  releasesInPlists: defaultReleasesInPlists,
  installUpdaterTools,
  planServiceRestart: (args) => planServiceRestart(args),
  restartService: (args) => restartService(args),
  resolveTagCommit,
  commitIsOnMain,
  checkHealth: defaultCheckHealth,
  releaseReportsCommit,
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
  // The approval this run acts on. persistOutcome consumes it once the apply
  // completes (applied or rolled back), so it authorizes exactly one attempt.
  let usedApproval = null;
  if (input.requireApproval !== false) {
    const authorized = approvalAuthorizes({ approval, tag: input.tag, commit, now: deps.now() });
    if (!authorized.ok) return fail("approval", authorized.reason);
    usedApproval = approval;
    record(
      "approval",
      "passed",
      `approved by ${approval.decidedByUserId} at ${approval.decidedAt}`
      + `${approval.expiresAt ? `, expires ${approval.expiresAt}` : ""}; single-use, consumed when this apply completes`,
    );
  } else {
    record("approval", "skipped", "approval gate explicitly disabled for this run");
  }

  // ---- 2b. Restart command --------------------------------------------------
  // Settled before anything is exported, backed up or switched. Without it the
  // restart used to run `/bin/sh -c undefined` (exit 127) AFTER the switch, and
  // the only thing that went right was the rollback.
  const restart = resolveRestartCommand({
    restartCommand: input.restartCommand,
    port: input.port,
    baseUrl: input.baseUrl,
    serviceLabel: input.serviceLabel,
  });
  if (!restart.ok) return fail("restart_command", `${restart.reason} Nothing was changed.`);
  if (restart.kind === "service") {
    // Preflight: the same verification the restart itself repeats, run now so
    // a restart that would refuse later refuses before backup and switch.
    const plan = deps.planServiceRestart({ port: restart.port, label: restart.label });
    if (!plan.ok) return fail("restart_command", `${plan.reason} Pass --restart-command to restart some other way. Nothing was changed.`);
    record("restart_command", "passed", `default restart (port from ${restart.from}): ${plan.detail}`);
  } else {
    record("restart_command", "passed", restart.detail);
  }
  const runRestart = ({ rollback = false } = {}) => (restart.kind === "service"
    ? deps.restartService({ port: restart.port, label: restart.label, allowNothingRunning: rollback })
    : deps.runCommand(restart.command, "restart"));

  // ---- 3. Compatibility -----------------------------------------------------
  const installedRoot = input.installedRoot ?? deps.readCurrent(input.releasesRoot) ?? input.repoDir;
  const exportTarget = () => deps.exportRelease({
    repoDir: input.repoDir,
    tag: input.tag,
    commit,
    releasesRoot: input.releasesRoot,
  });
  // The target's journal has to be read from the exported tree, so the export
  // happens first — it mutates nothing that is serving.
  let materialized;
  try {
    materialized = exportTarget();
  } catch (error) {
    return fail("materialize", `Export failed: ${error.message}`);
  }

  // ---- 3a. A directory left by an earlier run -------------------------------
  // The export reuses an existing directory for the same tag and commit. That
  // is right only for a finished release: one left by a run that failed before
  // completing was sealed read-only mid-way, and building into it fails with
  // EACCES. The completion marker, written after sealing, tells the two apart.
  let prebuilt = false;
  if (materialized.reused) {
    const marker = deps.readReleaseMarker(materialized.releaseDir);
    if (marker && marker.complete === true && marker.commit === commit) {
      prebuilt = true;
      record("reuse", "passed", `${materialized.releaseDir} was completed at ${marker.completedAt ?? "an unknown time"}; build skipped`);
    } else {
      const serving = [
        deps.readCurrent(input.releasesRoot),
        installedState?.current?.releaseDir,
        installedState?.previous?.releaseDir,
      ];
      // The same protections pruning applies: a live process, or an installed
      // launchd job whose plist names this directory (it would start from a
      // half-deleted tree on its next launch).
      let inUse;
      let configured;
      try {
        inUse = deps.releasesInUse(input.releasesRoot);
        configured = deps.releasesInPlists(input.releasesRoot, input.launchdPlistDirs ?? []);
      } catch (error) {
        return fail(
          "materialize",
          `${materialized.releaseDir} has no completion marker, and whether a process or a launchd job still uses it cannot be checked `
          + `(${error.message}). It was not removed; nothing was changed.`,
        );
      }
      const leftoverName = path.basename(materialized.releaseDir);
      if (inUse.includes(leftoverName)) {
        return fail(
          "materialize",
          `${materialized.releaseDir} has no completion marker, but a running process still uses it, so it will not be removed. Nothing was changed.`,
        );
      }
      if (configured.includes(leftoverName)) {
        return fail(
          "materialize",
          `${materialized.releaseDir} has no completion marker, but an installed launchd plist names it, so it will not be removed. `
          + "Nothing was changed. Point that job at another release (or unload it), then re-run.",
        );
      }
      if (serving.some((dir) => samePath(dir, materialized.releaseDir))) {
        return fail(
          "materialize",
          `${materialized.releaseDir} has no completion marker for ${commit.slice(0, 12)}, but it is the current or previous `
          + "release, so it will not be removed. Nothing was changed; recover it by hand.",
        );
      }
      if (input.dryRun) {
        record("reuse", "passed", `${materialized.releaseDir} has no completion marker; a real run removes and re-exports it`);
      } else {
        try {
          deps.removeRelease(materialized.releaseDir);
          materialized = exportTarget();
          if (materialized.reused) throw new Error(`${materialized.releaseDir} was still there after removing it`);
        } catch (error) {
          return fail("materialize", `Could not replace the incomplete ${materialized.releaseDir}: ${error.message}`);
        }
        record("reuse", "passed", "an earlier run left this directory without a completion marker; removed and re-exported");
      }
    }
  }

  const pending = pendingMigrationsBetween(installedRoot, materialized.releaseDir);
  const policy = evaluateMigrationPolicy({ pending, allowMigrations: Boolean(input.allowMigrations) });
  if (!policy.ok) return fail("compatibility", policy.reason, { pendingMigrations: pending });
  record("compatibility", "passed", policy.reason);

  // ---- 3b. Served-release check --------------------------------------------
  // After the restart, health must report this commit as the release being
  // served; "ok" from the old process is not an update. That needs the target
  // to report it. A target that predates the field could never pass, so it is
  // refused here, before anything is backed up or switched.
  if (!deps.releaseReportsCommit(materialized.releaseDir)) {
    return fail(
      "served_release",
      `${path.basename(materialized.releaseDir)} predates ${SERVED_COMMIT_HEALTH_FIELD} in /api/health, so this updater cannot `
      + "verify that it is the release being served after the restart. Nothing was changed.",
    );
  }
  record("served_release", "passed", `after the restart, /api/health must report ${SERVED_COMMIT_HEALTH_FIELD}=${commit.slice(0, 12)}`);

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
  if (prebuilt) {
    record("materialize", "passed", `${materialized.releaseDir} (reused; already built and sealed)`);
  } else {
    try {
      deps.buildRelease({ releaseDir: materialized.releaseDir });
      deps.sealRelease(materialized.releaseDir);
    } catch (error) {
      // Nothing has been switched yet, so the running instance is untouched.
      return fail("materialize", `Build failed (nothing was switched): ${error.message}`);
    }
    // Last, so its presence means every step before it finished. It is also
    // where the server reads the commit it reports in /api/health, so without
    // it the served-release check could never pass: fail now, before the
    // switch, rather than roll back after it. A rerun rebuilds the directory.
    try {
      deps.writeReleaseMarker(materialized.releaseDir, { tag: input.tag, commit, now: deps.now() });
    } catch (error) {
      return fail(
        "materialize",
        `The completion marker could not be written (${error.message}); the server reads its commit from it, so the `
        + "update could not be verified. Nothing was switched; a rerun rebuilds this directory.",
      );
    }
    record("materialize", "passed", `${materialized.releaseDir}; completion marker written`);
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
    const restarted = runRestart();
    record("restart", "passed", restarted?.detail);
    healthy = verifyServed(
      await deps.checkHealth(healthUrl, timeoutSec, input.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS, deps.log, {
        expectCommit: commit,
      }),
      commit,
    );
  } catch (error) {
    healthy = { ok: false, detail: `restart failed: ${error.message}` };
    record("restart", "failed", healthy.detail);
  }

  const approvalFields = usedApproval ? { approvalId: usedApproval.id ?? null, approval: usedApproval } : {};

  if (healthy.ok) {
    record("health", "passed", `${healthy.detail}; served release verified (${SERVED_COMMIT_HEALTH_FIELD}=${commit.slice(0, 12)})`);
    housekeepAfterApply({ input, deps, record, releaseDir: materialized.releaseDir, previousReleaseDir });
    return {
      outcome: "applied",
      tag: input.tag,
      commit,
      releaseDir: materialized.releaseDir,
      previousReleaseDir,
      ...approvalFields,
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
  } catch (error) {
    return fail("rollback", `Rollback failed: ${error.message}`, { backupPath });
  }
  // A failed rollback restart is recorded, not fatal. The usual cause is a new
  // release that crashed at boot: nothing is listening, launchd is already
  // restarting the job from the restored `current`, and the old release comes
  // back on its own. Only the health check can say whether the box recovered;
  // reporting "Manual recovery required" before asking it was wrong.
  let rollbackRestart = null;
  try {
    const restarted = runRestart({ rollback: true });
    record("rollback_restart", restarted?.restarted === false ? "skipped" : "passed", restarted?.detail);
  } catch (error) {
    rollbackRestart = error.message;
    record("rollback_restart", "failed", `${error.message}; checking health anyway`);
  }

  // The rollback target may be a release older than the served-release field.
  // Then health ok without it is accepted, and the receipt says the served
  // release was NOT verified; for a target that reports it, it must match.
  const rollbackExpectation = servedReleaseExpectation(previousReleaseDir, deps);
  const recovered = verifyServed(
    await deps.checkHealth(healthUrl, timeoutSec, input.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS, deps.log, {
      expectCommit: rollbackExpectation.expectCommit,
    }),
    rollbackExpectation.expectCommit,
  );
  const rollbackServed = rollbackExpectation.expectCommit
    ? `served release verified (${SERVED_COMMIT_HEALTH_FIELD}=${rollbackExpectation.expectCommit.slice(0, 12)})`
    : `served release NOT verified: ${rollbackExpectation.reason}; health ok accepted without it`;
  record("rollback_health", recovered.ok ? "passed" : "failed", recovered.ok ? `${recovered.detail}; ${rollbackServed}` : recovered.detail);

  return {
    outcome: recovered.ok ? "rolled_back" : "failed",
    tag: input.tag,
    commit,
    releaseDir: previousReleaseDir,
    attemptedReleaseDir: materialized.releaseDir,
    previousReleaseDir,
    ...approvalFields,
    backupPath,
    pendingMigrations: pending,
    checks,
    startedAt,
    finishedAt: deps.now(),
    signatureVerified: false,
    error: recovered.ok
      ? `Update failed health (${healthy.detail}); rolled back to the previous release.`
      : `Update failed health (${healthy.detail}) AND rollback did not recover (${recovered.detail}`
        + `${rollbackRestart ? `; the rollback restart also failed: ${rollbackRestart}` : ""}). Manual recovery required.`,
  };
}

/**
 * What a healthy apply does after the fact. Each step is recorded in the
 * receipt, and none of them changes the outcome: the instance is already
 * serving the new release and has proved it, so a full disk or a missing file
 * here is something to report, not a reason to call the update failed.
 */
function housekeepAfterApply({ input, deps, record, releaseDir, previousReleaseDir }) {
  // The daily job's copies of the updater, from the release just proved.
  if (input.binDir) {
    try {
      const installed = deps.installUpdaterTools({ releaseDir, binDir: input.binDir });
      if (installed.skipped) record("install_updater", "skipped", installed.detail);
      else record("install_updater", "passed", `${installed.installed.join(", ")} -> ${installed.binDir}`);
    } catch (error) {
      record("install_updater", "failed", `(non-fatal) ${error.message}`);
    }
  } else {
    record("install_updater", "skipped", "no bin dir configured");
  }

  // Old releases. Current and the rollback target are always kept, and so is
  // anything a live process or an installed launchd job still uses.
  const pruned = runPrune({ ...input, protectedDirs: [releaseDir, previousReleaseDir] }, deps);
  record("prune", pruned.status, pruned.detail);
}

/**
 * One prune, with every protection, as a receipt check: `{ status, detail }`.
 *
 * Fails safe. If what is in use cannot be determined, nothing is deleted and
 * the check says so. More than PRUNE_CONFIRM_THRESHOLD removals at once are
 * held unless `pruneConfirm`, with the exact list in the detail.
 */
export function runPrune(input, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const keep = input.keepReleases ?? DEFAULT_KEEP_RELEASES;
  let inUse;
  let configured;
  try {
    inUse = deps.releasesInUse(input.releasesRoot);
    configured = deps.releasesInPlists(input.releasesRoot, input.launchdPlistDirs ?? []);
  } catch (error) {
    return { status: "failed", detail: `(non-fatal) nothing was pruned: ${error.message}` };
  }
  const protectedNames = (input.protectedDirs ?? []).filter(Boolean).map((dir) => path.basename(dir));
  let result;
  try {
    result = deps.pruneReleases({
      releasesRoot: input.releasesRoot,
      keep,
      protectedNames,
      inUseNames: [...inUse, ...configured],
      includeUntagged: Boolean(input.pruneUntagged),
      maxRemovals: PRUNE_CONFIRM_THRESHOLD,
      confirmed: Boolean(input.pruneConfirm),
      dryRun: Boolean(input.pruneDryRun),
    });
  } catch (error) {
    return { status: "failed", detail: `(non-fatal) ${error.message}` };
  }
  const extra = [...new Set([...inUse, ...configured])].filter((name) => !protectedNames.includes(name));
  const kept = `kept ${protectedNames.length > 0 ? `${protectedNames.join(", ")}, ` : ""}`
    + `${extra.length > 0 ? `in use or configured (${extra.join(", ")}), ` : ""}`
    + `and up to ${keep} more release tags${input.pruneUntagged ? " (untagged directories included)" : "; untagged directories are never pruned without --prune-untagged"}`;
  if (result.dryRun) {
    return { status: "skipped", detail: `dry run; would remove ${result.planned.length}: ${result.planned.join(", ") || "nothing"}; ${kept}` };
  }
  if (result.held) {
    return {
      status: "skipped",
      detail:
        `held: ${result.planned.length} directories would be removed at once (more than ${PRUNE_CONFIRM_THRESHOLD}), so none were: `
        + `${result.planned.join(", ")}. Review the list, then run ota-apply.mjs --prune --prune-confirm. ${kept}`,
    };
  }
  return {
    status: "passed",
    detail: result.removed.length > 0 ? `removed ${result.removed.join(", ")}; ${kept}` : `nothing to remove; ${kept}`,
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
  const written = { receiptPath: null, statePath: null, approvalConsumed: null, error: null };
  const receiptDir = path.join(stateDir, "receipts");
  const stamp = String(result.finishedAt).replace(/[:.]/g, "-");
  const receiptPath = path.join(receiptDir, `${stamp}-ota-${result.outcome}.json`);

  // An approval authorizes one completed attempt. Consumed first and on its
  // own, so a receipt that cannot be written never leaves it reusable. A run
  // that failed before completing (a refused gate, a build failure, a
  // rollback that did not recover) keeps it: nothing was settled.
  let approvalConsumed = null;
  if (result.approval && (result.outcome === "applied" || result.outcome === "rolled_back")) {
    try {
      approvalConsumed = consumeApproval({
        stateDir,
        approval: result.approval,
        receiptPath,
        outcome: result.outcome,
        now: result.finishedAt,
      });
    } catch (error) {
      approvalConsumed = { consumed: false, detail: `could not consume the approval: ${error instanceof Error ? error.message : String(error)}` };
    }
    written.approvalConsumed = approvalConsumed;
  }

  try {
    mkdirSync(receiptDir, { recursive: true });
    const receipt = {
      schemaVersion: 2,
      outcome: result.outcome,
      mode,
      channel,
      to: result.tag ? { tag: result.tag, commit: result.commit ?? null, releaseDir: result.releaseDir ?? null } : null,
      previousReleaseDir: result.previousReleaseDir ?? null,
      attemptedReleaseDir: result.attemptedReleaseDir ?? null,
      approvalId: result.approvalId ?? null,
      approvalConsumed,
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

      // The offer was consumed by this apply. Clearing it means the board reads
      // "up to date" until the next --check writes a fresh offer — otherwise a
      // stale file would keep offering the release just installed.
      writeFileSync(
        path.join(stateDir, AVAILABLE_RELEASE_FILENAME),
        `${JSON.stringify({ release: null, diff: null, releaseMigrations: null, checkedAt: result.finishedAt }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } catch (error) {
    written.error = error instanceof Error ? error.message : String(error);
  }
  return written;
}

/**
 * Ordered migration tags at a commit, read via `git show` so a check does not
 * need to materialize the candidate. Null when unreadable — "cannot tell" must
 * never collapse into "no migrations", the same rule readJournalTags follows.
 */
export function readJournalTagsAtCommit(repoDir, commit, gitFn = git) {
  let raw;
  try {
    raw = gitFn(repoDir, ["show", `${commit}:${JOURNAL_GIT_PATH}`]);
  } catch {
    return null;
  }
  try {
    const journal = JSON.parse(raw);
    if (!Array.isArray(journal.entries)) return null;
    return journal.entries.slice().sort((a, b) => a.idx - b.idx).map((entry) => entry.tag);
  } catch {
    return null;
  }
}

/**
 * The diff a person needs before approving: counts, commit subjects, and which
 * migration files arrive. Mirrors `summarizeDiff` in the TS planner.
 */
export function summarizeRangeDiff(repoDir, fromCommit, toCommit, gitFn = git) {
  const numstat = gitFn(repoDir, ["diff", "--numstat", `${fromCommit}..${toCommit}`]);
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n")) {
    const match = line.match(/^(\S+)\t(\S+)\t/);
    if (!match) continue;
    filesChanged += 1;
    // Binary files numstat as "-\t-"; they count as changed files, not lines.
    if (match[1] !== "-") insertions += Number(match[1]);
    if (match[2] !== "-") deletions += Number(match[2]);
  }
  const commitSubjects = gitFn(repoDir, ["log", "--format=%s", `${fromCommit}..${toCommit}`])
    .split("\n").map((s) => s.trim()).filter(Boolean);
  const migrationsAdded = gitFn(repoDir, ["diff", "--name-only", `${fromCommit}..${toCommit}`, "--", MIGRATIONS_GIT_DIR])
    .split("\n").map((s) => s.trim()).filter(Boolean);
  return {
    commitCount: commitSubjects.length,
    filesChanged,
    insertions,
    deletions,
    commitSubjects: commitSubjects.slice(0, MAX_COMMIT_SUBJECTS),
    truncated: commitSubjects.length > MAX_COMMIT_SUBJECTS,
    migrationsAdded,
  };
}

/**
 * Release notes from the GitHub Release, best-effort. The offer is still
 * written when `gh` is absent or the tag has no Release — notes, url and
 * publishedAt are all nullable in the contract, and a missing body is a
 * smaller lie than no offer at all.
 */
function defaultReleaseNotes(repoDir, tag) {
  try {
    const result = spawnSync("gh", ["release", "view", tag, "--json", "body,url,publishedAt"], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: GH_CLI_TIMEOUT_MS,
    });
    if (result.status !== 0) return { notes: "", url: null, publishedAt: null };
    const parsed = JSON.parse(result.stdout ?? "{}");
    return {
      notes: typeof parsed.body === "string" ? parsed.body : "",
      url: typeof parsed.url === "string" ? parsed.url : null,
      publishedAt: typeof parsed.publishedAt === "string" ? parsed.publishedAt : null,
    };
  } catch {
    return { notes: "", url: null, publishedAt: null };
  }
}

export const defaultCheckDeps = {
  git,
  resolveTagCommit,
  assessDirection: assessUpdateDirection,
  releaseNotes: defaultReleaseNotes,
  now: nowIso,
};

/**
 * What commit is this box actually on? `deployment-state.json` is written by
 * the apply path and is absent on a box that still serves straight from its
 * git checkout — exactly the boxes a release offer matters most for. On those
 * boxes HEAD is the only observed fact: it is what the running code was
 * cloned at, while `source-state.json` is a record someone wrote once and
 * can go stale the moment a human pulls by hand. The server's
 * reconcileDeploymentState applies the same rule — the running commit wins
 * over any recorded state — so the order here is canonical file, then HEAD,
 * then the legacy file as the last record left when git itself cannot answer.
 */
function installedCommitForCheck(repoDir, stateDir, deps) {
  const canonical = readJsonFile(path.join(stateDir, CANONICAL_STATE_FILENAME))?.current?.commit;
  if (typeof canonical === "string" && canonical) return canonical;
  try {
    const head = deps.git(repoDir, ["rev-parse", "HEAD"]);
    if (typeof head === "string" && head.trim()) return head.trim();
  } catch {
    // Not a git checkout — fall through to the recorded state.
  }
  const legacy = readJsonFile(path.join(stateDir, LEGACY_SOURCE_STATE_FILENAME))?.currentSha;
  if (typeof legacy === "string" && legacy) return legacy;
  return "";
}

/**
 * Write the offer atomically — a reader that opens the file mid-write must
 * see the previous complete offer or the next one, never a torn half.
 */
function writeAvailableRelease(stateDir, file) {
  mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, AVAILABLE_RELEASE_FILENAME);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, filePath);
  return filePath;
}

/**
 * Refresh `available-release.json` — the file the board's status endpoint
 * reads. This is the ONLY component allowed to run git and reach the network;
 * the status service stays read-only by design, so the discovery half lives
 * here, on the updater side, where launchd can run it on a schedule.
 *
 * The candidate is the newest release tag on origin/main that the apply path
 * could actually move to: a tag the direction guard would refuse (an ancestor
 * of, or diverged from, the installed commit) is skipped rather than offered,
 * because a button offering an update the updater then refuses is worse than
 * no button.
 *
 * `release: null` means "checked, and there is nothing to apply" — either the
 * instance is already on the newest applicable commit or no release tag
 * exists. It is written rather than left absent so `checkedAt` keeps saying
 * when the answer was last recomputed. A check that fails writes the error
 * the same way, because a stale success is worse than a fresh failure.
 */
export async function runCheck(input, overrides = {}) {
  const deps = { ...defaultCheckDeps, ...overrides };
  const stateDir = input.stateDir;
  const checkedAt = deps.now();

  let file;
  try {
    // No --prune: pruning deletes tags that exist only locally, which on a
    // bootstrap box can be the record of what was once applied.
    deps.git(input.repoDir, ["fetch", "origin", "--tags"], GIT_FETCH_TIMEOUT_MS);

    const tags = deps.git(input.repoDir, ["tag", "--merged", "origin/main"])
      .split("\n")
      .map((tag) => tag.trim())
      .filter(isReleaseTag)
      .sort((a, b) => compareReleaseTags(b, a));

    const installedCommit = installedCommitForCheck(input.repoDir, stateDir, deps);

    let candidate = null;
    const skipped = [];
    for (const tag of tags) {
      let commit;
      try {
        commit = deps.resolveTagCommit(input.repoDir, tag);
      } catch {
        continue;
      }
      const direction = deps.assessDirection(input.repoDir, installedCommit || null, commit);
      if (direction.direction === "backward" || direction.direction === "diverged") {
        skipped.push(`${tag} (${direction.direction} of the installed commit)`);
        continue;
      }
      candidate = { tag, commit, upToDate: direction.direction === "same" };
      break;
    }

    if (!candidate || candidate.upToDate) {
      file = { release: null, diff: null, releaseMigrations: null, checkedAt };
      if (skipped.length > 0) {
        file.note = `Newer tag(s) skipped because the apply path would refuse them: ${skipped.join(", ")}.`;
      } else if (!candidate) {
        file.note = "No release tag found on origin/main.";
      }
    } else {
      const notes = deps.releaseNotes(input.repoDir, candidate.tag);
      const journalTags = readJournalTagsAtCommit(input.repoDir, candidate.commit, deps.git);
      file = {
        release: {
          tag: candidate.tag,
          version: candidate.tag.replace(/^v/, ""),
          commit: candidate.commit,
          channel: "stable",
          publishedAt: notes.publishedAt,
          notes: notes.notes,
          url: notes.url,
        },
        diff: installedCommit
          ? summarizeRangeDiff(input.repoDir, installedCommit, candidate.commit, deps.git)
          : null,
        releaseMigrations: journalTags === null
          ? null
          : journalTags.map((tag) => ({ id: tag, name: tag, reversible: false })),
        checkedAt,
      };
    }
  } catch (error) {
    // A failed check must still say so in the file the board reads: "no new
    // offer" and "the check never ran" look identical otherwise, and the
    // second is the one an operator needs to see.
    file = {
      release: null,
      diff: null,
      releaseMigrations: null,
      checkedAt,
      error: `release check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const filePath = writeAvailableRelease(stateDir, file);
  return { ...file, written: filePath };
}

function usage() {
  return `Apply an approved AgentDash release.

  --check                    Refresh available-release.json (what the board
                             offers) and exit. Applies nothing; this is what
                             the daily launchd job runs.
  --repo-dir <path>          Git clone used only as a source of releases
  --releases-root <path>     Where immutable release directories live
  --state-dir <path>         Deployment state and approval directory
  --tag <vYYYY.MDD.N>        Release tag to apply (must be on origin/main)
  --base-url <url>           Instance base URL for the health check
                             (default ${DEFAULT_BASE_URL})
  --restart-command <cmd>    Shell command that restarts the service. Default:
                             kill the server's process chain, verified against
                             its launchd job, which KeepAlive restarts from
                             releases/current. Refused before anything changes
                             when the chain cannot be verified.
  --service-label <label>    launchd job of the server (default
                             ${DEFAULT_SERVICE_LABEL}); looked up in
                             system/ and then gui/<uid>/
  --port <n>                 Server port for the default restart (default: the
                             port of a loopback --base-url)
  --keep-releases <n>        Release tags kept besides current and previous
                             when pruning (default ${DEFAULT_KEEP_RELEASES})
  --prune                    Prune releases and exit (with --dry-run: only list)
  --prune-confirm            Allow more than ${PRUNE_CONFIRM_THRESHOLD} removals in one prune
  --prune-untagged           Also prune candidate-*, hotfix-* and other
                             directories that are not release tags
  --bin-dir <path>           Where the daily job's updater copies live; a
                             healthy apply refreshes them from the new release
                             (default ~/.agentdash/bin)
  --backup-command <cmd>     Shell command that takes a database backup
  --skip-backup              Proceed without a backup, deliberately
  --allow-migrations         Permit a release that adds migrations (see below)
  --no-approval              Skip the approval gate (bootstrap only)
  --health-timeout <sec>     Default ${DEFAULT_HEALTH_TIMEOUT_SEC}
  --dry-run                  Stop after compatibility; switch nothing

Approvals are single-use: an apply that completes (applied or rolled back)
moves pending-approval.json into used-approvals/, and an approval with an
expiresAt in the past is refused. After the restart, /api/health must report
releaseCommit = the target commit; a healthy answer from the old process is
a failure and rolls back.

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
      "service-label": { type: "string" },
      port: { type: "string" },
      prune: { type: "boolean" },
      "prune-confirm": { type: "boolean" },
      "prune-untagged": { type: "boolean" },
      "keep-releases": { type: "string" },
      "bin-dir": { type: "string" },
      "backup-command": { type: "string" },
      "backup-path-hint": { type: "string" },
      "skip-backup": { type: "boolean" },
      "allow-migrations": { type: "boolean" },
      "no-approval": { type: "boolean" },
      "health-timeout": { type: "string" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      check: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });

  const home = os.homedir();

  if (values.help) {
    console.log(usage());
    return 0;
  }

  if (values.check) {
    const result = await runCheck({
      repoDir: values["repo-dir"] ?? path.join(home, "agentdash"),
      releasesRoot: values["releases-root"] ?? path.join(home, ".agentdash", "releases"),
      stateDir: values["state-dir"] ?? path.join(home, ".agentdash", "deployments"),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  let keepReleases;
  if (values["keep-releases"] !== undefined) {
    keepReleases = Number(values["keep-releases"]);
    if (!Number.isInteger(keepReleases) || keepReleases < 0) {
      console.error(`--keep-releases must be a whole number, got '${values["keep-releases"]}'.`);
      return 1;
    }
  }
  const releasesRoot = values["releases-root"] ?? path.join(home, ".agentdash", "releases");
  const stateDir = values["state-dir"] ?? path.join(home, ".agentdash", "deployments");
  // Every installed launchd job's configured paths protect the releases they name.
  const launchdPlistDirs = ["/Library/LaunchDaemons", path.join(home, "Library", "LaunchAgents")];
  const pruneOptions = {
    releasesRoot,
    keepReleases,
    launchdPlistDirs,
    pruneConfirm: Boolean(values["prune-confirm"]),
    pruneUntagged: Boolean(values["prune-untagged"]),
  };

  if (values.prune) {
    const state = readJsonFile(path.join(stateDir, CANONICAL_STATE_FILENAME));
    const result = runPrune({
      ...pruneOptions,
      pruneDryRun: Boolean(values["dry-run"]),
      protectedDirs: [defaultReadCurrent(releasesRoot), state?.current?.releaseDir, state?.previous?.releaseDir],
    });
    console.log(JSON.stringify(result, null, 2));
    return result.status === "failed" ? 1 : 0;
  }

  if (!values.tag) {
    console.log(usage());
    return 1;
  }
  const result = await runApply({
    repoDir: values["repo-dir"] ?? path.join(home, "agentdash"),
    releasesRoot: values["releases-root"] ?? path.join(home, ".agentdash", "releases"),
    stateDir: values["state-dir"] ?? path.join(home, ".agentdash", "deployments"),
    tag: values.tag,
    baseUrl: values["base-url"] ?? DEFAULT_BASE_URL,
    restartCommand: values["restart-command"],
    serviceLabel: values["service-label"],
    port: values.port,
    ...pruneOptions,
    binDir: values["bin-dir"] ?? path.join(home, ".agentdash", "bin"),
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

// import.meta.url is the resolved real path while process.argv[1] is the path
// as typed, so a plain comparison silently skips main() when the script is run
// through a symlink (e.g. releases/current). Compare realpaths on both sides.
const invokedDirectly = (() => {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
    );
  } catch {
    // argv[1] can name a path that does not exist (e.g. a positional arg under
    // `node -e`); an unresolvable entry path cannot be this file's direct run.
    return false;
  }
})();
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}

export default {
  runApply,
  persistOutcome,
  assessUpdateDirection,
  evaluateMigrationPolicy,
  pendingMigrationsBetween,
  approvalAuthorizes,
  readJournalTags,
  resolveRestartCommand,
  planServiceRestart,
  restartService,
  runPrune,
  installUpdaterTools,
  consumeApproval,
  readUpdaterVersion,
  releaseReportsCommit,
  UPDATER_VERSION,
};
