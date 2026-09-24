// AgentDash (OBS-5, #698): tell a stuck run from a quiet one.
//
// The stale-active-run evaluator used to judge liveness by output silence
// alone. That is right for adapters that stream (claude_local, codex_local, ...)
// and wrong for `hermes_local`, which runs `hermes chat -Q` and prints nothing
// until it exits: every healthy Hermes run over an hour opened a manager review
// ticket (AGE-169, AGE-170). Hermes does keep a ledger while it works, one
// `session_model_usage` row per model per session, whose `last_seen` moves on
// every model call. So for Hermes, "alive" means the process is still there
// AND that ledger is advancing; for everything else it means output, as before.
//
// The same evidence gives the first-output deadline: a run whose process is up
// but which has produced no output (streaming) or no ledger row (Hermes) after
// `firstOutputDeadlineMs` is a zero-turn hang, and waiting for the full time
// budget made those fire 5.8x late (2026-09-05 review).
//
// Overlap note: OBS-1 (#694) is teaching `server/src/adapters/hermes-usage.ts`
// to read the per-profile ledger for metering. This module deliberately keeps
// its own small read-only reader and path resolver instead of touching that
// file; once #694 lands, `resolveHermesLedgerPathForRun` can delegate to its
// resolver.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runningProcesses } from "../adapters/index.js";

export const DEFAULT_FIRST_OUTPUT_DEADLINE_MS = 10 * 60 * 1000;
export const NO_FIRST_OUTPUT_ERROR_CODE = "no_first_output";

/** Adapters whose liveness is judged from a ledger rather than streamed output. */
const LEDGER_PROBED_ADAPTERS = new Set(["hermes_local"]);

/** Hermes may create its session row a moment before the server records the spawn. */
const SESSION_START_SLACK_MS = 30_000;

export type RunLivenessProbeKind = "output" | "hermes_ledger";

export type LedgerReadStatus =
  | "not_applicable"
  | "read"
  | "missing"
  | "unreadable";

export interface RunForLivenessProbe {
  id: string;
  sessionIdBefore?: string | null;
  processPid?: number | null;
  processGroupId?: number | null;
  processStartedAt?: Date | null;
  startedAt?: Date | null;
  createdAt?: Date | null;
  lastOutputAt?: Date | null;
}

export interface RunLivenessEvidence {
  probe: RunLivenessProbeKind;
  /** true/false when observable on this host, null when there is nothing to check. */
  processAlive: boolean | null;
  lastOutputAt: Date | null;
  /** Latest ledger activity for the run's session(s) since the run started. */
  ledgerActivityAt: Date | null;
  /** Earliest ledger activity since the run started: Hermes' first completed model call. */
  firstLedgerActivityAt: Date | null;
  ledgerPath: string | null;
  ledgerStatus: LedgerReadStatus;
  sessionIds: string[];
}

export interface LedgerActivity {
  status: LedgerReadStatus;
  sessionIds: string[];
  /** Conservative "latest": the least recent of the attributed sessions' latest activity. */
  lastActivityAt: Date | null;
  /** Latest activity across every attributed session. */
  anyActivityAt: Date | null;
  firstActivityAt: Date | null;
}

export interface RunLivenessProbeOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the ledger path (tests, operators). */
  ledgerPath?: string | null;
  isPidAlive?: (pid: number) => boolean;
  isProcessGroupAlive?: (pgid: number) => boolean;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function isLedgerProbedAdapter(adapterType: string) {
  return LEDGER_PROBED_ADAPTERS.has(adapterType);
}

function defaultIsPidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

function defaultIsProcessGroupAlive(pgid: number) {
  if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 0) return false;
  return defaultIsPidAlive(-pgid);
}

/**
 * Whether the run's process is still there. Prefers the in-memory handle,
 * then the recorded pid, then the process group. `null` means there is
 * nothing on this host to check (Hermes runs often record no pid).
 */
export function probeRunProcessAlive(run: RunForLivenessProbe, opts: RunLivenessProbeOptions = {}): boolean | null {
  const running = runningProcesses.get(run.id);
  if (running) {
    return running.child.exitCode === null && running.child.signalCode === null;
  }
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const isGroupAlive = opts.isProcessGroupAlive ?? defaultIsProcessGroupAlive;
  if (typeof run.processPid === "number" && run.processPid > 0) {
    if (isPidAlive(run.processPid)) return true;
    if (typeof run.processGroupId === "number" && run.processGroupId > 0) return isGroupAlive(run.processGroupId);
    return false;
  }
  if (typeof run.processGroupId === "number" && run.processGroupId > 0) return isGroupAlive(run.processGroupId);
  return null;
}

function hermesProfileFromArgs(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== "string") continue;
    if ((arg === "-p" || arg === "--profile") && typeof args[index + 1] === "string") {
      return readString(args[index + 1]);
    }
    if (arg.startsWith("--profile=")) return readString(arg.slice("--profile=".length));
  }
  return null;
}

/**
 * Which Hermes ledger a run writes to.
 *
 * Order: an explicit `AGENTDASH_HERMES_STATE_DB`, then `HERMES_HOME`, then the
 * run's profile ledger (`<profiles>/<name>/state.db`, profile taken from the
 * config, from `-p/--profile` in the extra args, or from the alias-wrapper
 * command name when a profile of that name exists), then the root ledger.
 */
export function resolveHermesLedgerPathForRun(
  adapterConfig: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = readString(env.AGENTDASH_HERMES_STATE_DB);
  if (explicit) return path.resolve(explicit);
  const hermesHome = readString(env.HERMES_HOME);
  if (hermesHome) return path.resolve(hermesHome, "state.db");

  const hermesRoot = path.join(os.homedir(), ".hermes");
  const profilesDir = readString(env.HERMES_PROFILES_DIR) ?? path.join(hermesRoot, "profiles");
  const config = adapterConfig ?? {};
  const commandName = readString(config.hermesCommand) ?? readString(config.command);
  const candidates = [
    readString(config.hermesProfile),
    readString(config.profile),
    hermesProfileFromArgs(config.extraArgs),
    hermesProfileFromArgs(config.args),
    commandName ? path.basename(commandName) : null,
  ].filter((value): value is string => Boolean(value) && /^[A-Za-z0-9_.-]+$/.test(value!));
  for (const profile of candidates) {
    const profileDb = path.join(profilesDir, profile, "state.db");
    if (existsSync(profileDb)) return profileDb;
  }
  return path.join(hermesRoot, "state.db");
}

function toDate(seconds: unknown): Date | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

/**
 * Read-only view of what a Hermes ledger says about a run.
 *
 * Attribution: the resumed session (`sessionIdBefore`) and its compaction
 * children when it has activity since the run started; otherwise every session
 * that opened after the run started and has not ended. When several such open
 * sessions exist (agents sharing a profile), `lastActivityAt` is the least
 * recent of them, so another agent's progress can never make a stuck run look
 * alive. Every failure is reported as a status, never thrown.
 */
export function readHermesLedgerActivity(input: {
  ledgerPath: string;
  sessionId?: string | null;
  runStartedAt: Date;
}): LedgerActivity {
  const empty = (status: LedgerReadStatus): LedgerActivity => ({
    status,
    sessionIds: [],
    lastActivityAt: null,
    anyActivityAt: null,
    firstActivityAt: null,
  });
  if (!existsSync(input.ledgerPath)) return empty("missing");

  const sinceSec = input.runStartedAt.getTime() / 1000;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(input.ledgerPath, { readOnly: true });
    const activityFor = (sessionIds: string[]) => {
      const rows: Array<{ sessionId: string; first: Date | null; last: Date | null }> = [];
      const stmt = db!.prepare(
        `SELECT MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen
           FROM session_model_usage
          WHERE (session_id = ? OR session_id IN (SELECT id FROM sessions WHERE parent_session_id = ?))
            AND last_seen >= ?`,
      );
      for (const sessionId of sessionIds) {
        const row = stmt.get(sessionId, sessionId, sinceSec) as { first_seen?: unknown; last_seen?: unknown } | undefined;
        const last = toDate(row?.last_seen);
        const firstRaw = toDate(row?.first_seen);
        // A resumed session's first row can predate this run; clamp to the run.
        const first = firstRaw && last ? new Date(Math.max(firstRaw.getTime(), input.runStartedAt.getTime())) : null;
        rows.push({ sessionId, first, last });
      }
      return rows;
    };

    let attributed = [] as ReturnType<typeof activityFor>;
    const sessionId = readString(input.sessionId);
    if (sessionId) {
      attributed = activityFor([sessionId]).filter((row) => row.last !== null);
    }
    if (attributed.length === 0) {
      const openSessions = db
        .prepare(`SELECT id FROM sessions WHERE started_at >= ? AND ended_at IS NULL`)
        .all(sinceSec - SESSION_START_SLACK_MS / 1000) as Array<{ id: string }>;
      attributed = activityFor(openSessions.map((row) => row.id));
    }
    if (attributed.length === 0) return empty("read");

    const lasts = attributed.map((row) => row.last?.getTime() ?? null);
    const firsts = attributed.map((row) => row.first?.getTime()).filter((value): value is number => value != null);
    const anyLast = lasts.filter((value): value is number => value != null);
    return {
      status: "read",
      sessionIds: attributed.map((row) => row.sessionId),
      lastActivityAt: lasts.some((value) => value === null) ? null : new Date(Math.min(...(lasts as number[]))),
      anyActivityAt: anyLast.length > 0 ? new Date(Math.max(...anyLast)) : null,
      firstActivityAt: firsts.length > 0 ? new Date(Math.min(...firsts)) : null,
    };
  } catch {
    return empty("unreadable");
  } finally {
    try {
      db?.close();
    } catch {
      // Read-only handle; nothing useful to do.
    }
  }
}

function runStartedAt(run: RunForLivenessProbe): Date | null {
  return run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
}

/** Gather the liveness evidence for one running run. */
export function probeRunLiveness(
  run: RunForLivenessProbe,
  agent: { adapterType: string; adapterConfig: unknown },
  opts: RunLivenessProbeOptions = {},
): RunLivenessEvidence {
  const processAlive = probeRunProcessAlive(run, opts);
  const base: RunLivenessEvidence = {
    probe: "output",
    processAlive,
    lastOutputAt: run.lastOutputAt ?? null,
    ledgerActivityAt: null,
    firstLedgerActivityAt: null,
    ledgerPath: null,
    ledgerStatus: "not_applicable",
    sessionIds: [],
  };
  if (!isLedgerProbedAdapter(agent.adapterType)) return base;

  const startedAt = runStartedAt(run);
  const ledgerPath = opts.ledgerPath ?? resolveHermesLedgerPathForRun(readRecord(agent.adapterConfig), opts.env);
  if (!startedAt) return { ...base, probe: "hermes_ledger", ledgerPath, ledgerStatus: "unreadable" };
  const activity = readHermesLedgerActivity({ ledgerPath, sessionId: run.sessionIdBefore, runStartedAt: startedAt });
  return {
    ...base,
    probe: "hermes_ledger",
    ledgerPath,
    ledgerStatus: activity.status,
    sessionIds: activity.sessionIds,
    ledgerActivityAt: activity.lastActivityAt,
    firstLedgerActivityAt: activity.firstActivityAt ?? activity.anyActivityAt,
  };
}

/**
 * The moment silence is measured from. For a ledger-probed run whose process
 * is alive (or unobservable) and whose ledger was read, ledger activity counts
 * as activity; otherwise this is exactly the old output-silence start.
 */
export function effectiveActivityAt(run: RunForLivenessProbe, evidence: RunLivenessEvidence): Date | null {
  const outputStart = run.lastOutputAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
  if (evidence.probe !== "hermes_ledger" || evidence.processAlive === false || evidence.ledgerStatus !== "read") {
    return outputStart;
  }
  const ledger = evidence.ledgerActivityAt;
  if (!ledger) return outputStart;
  if (!outputStart) return ledger;
  return ledger.getTime() > outputStart.getTime() ? ledger : outputStart;
}

/**
 * The first-output deadline for an agent, in ms, or null when disabled.
 *
 * `adapterConfig.firstOutputDeadlineSec` wins (0 disables). Otherwise
 * `AGENTDASH_FIRST_OUTPUT_DEADLINE_MS` (0 disables), otherwise 10 minutes for
 * ledger-probed adapters. Streaming adapters are opt-in through the config
 * key: their own pre-spawn log lines count as output, so a default there
 * would judge the wrapper rather than the model.
 */
export function resolveFirstOutputDeadlineMs(
  adapterType: string,
  adapterConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const config = readRecord(adapterConfig) ?? {};
  const configured = config.firstOutputDeadlineSec;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return configured > 0 ? Math.floor(configured * 1000) : null;
  }
  if (!isLedgerProbedAdapter(adapterType)) return null;
  const fromEnv = readString(env.AGENTDASH_FIRST_OUTPUT_DEADLINE_MS);
  if (fromEnv !== null) {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed)) return parsed > 0 ? Math.floor(parsed) : null;
  }
  return DEFAULT_FIRST_OUTPUT_DEADLINE_MS;
}

/**
 * Whether a run has shown its first sign of model work. `null` means the
 * evidence cannot tell (ledger missing or unreadable), and a caller must not
 * stop a run on it.
 */
export function hasFirstOutput(run: RunForLivenessProbe, evidence: RunLivenessEvidence): boolean | null {
  if (evidence.probe === "hermes_ledger") {
    if (evidence.ledgerStatus !== "read") return null;
    return evidence.firstLedgerActivityAt !== null;
  }
  const spawnedAt = run.processStartedAt ?? null;
  if (!run.lastOutputAt) return false;
  if (!spawnedAt) return true;
  return run.lastOutputAt.getTime() >= spawnedAt.getTime();
}
