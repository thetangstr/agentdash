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
// The same evidence feeds the first-output deadline (zero-turn hangs fired the
// time budget 5.8x late in the 2026-09-05 review). Stopping a run is far more
// dangerous than suppressing a ticket, so the deadline only ever acts on a
// ledger resolved with certainty AND a session attributed to this run's
// window; anything less is reported, never acted on. See
// `classifyFirstOutput`.
//
// Overlap note: OBS-1 (#694) is teaching `server/src/adapters/hermes-usage.ts`
// to read the per-profile ledger for metering. This module deliberately keeps
// its own small read-only reader and resolver instead of touching that file;
// once #694 lands, the two resolvers should become one.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runningProcesses } from "../adapters/index.js";

export const DEFAULT_FIRST_OUTPUT_DEADLINE_MS = 10 * 60 * 1000;
export const NO_FIRST_OUTPUT_ERROR_CODE = "no_first_output";
export const WOULD_STOP_NO_FIRST_OUTPUT_EVENT = "would_stop_no_first_output";

/** Adapters whose liveness is judged from a ledger rather than streamed output. */
const LEDGER_PROBED_ADAPTERS = new Set(["hermes_local"]);

/** Hermes may create its session row a moment before the server records the spawn. */
const SESSION_START_SLACK_MS = 30_000;
/**
 * A session counts as this run's own only if it opened within this long of the
 * process start. Hermes opens its session row within seconds of starting; a
 * session opened much later belongs to some other run on a shared profile.
 */
const SESSION_ATTRIBUTION_WINDOW_MS = 2 * 60 * 1000;
const WRAPPER_MAX_BYTES = 64 * 1024;
const PROFILE_NAME = /^[A-Za-z0-9_.-]+$/;

export type RunLivenessProbeKind = "output" | "hermes_ledger";
export type LedgerReadStatus = "not_applicable" | "read" | "missing" | "unreadable";
/** `certain`: the run provably writes this ledger. `uncertain`: a best guess (sticky active profile, root fallback). */
export type LedgerCertainty = "certain" | "uncertain";

export interface HermesLedgerResolution {
  path: string;
  certainty: LedgerCertainty;
  /** How the path was found, for evidence and logs. */
  source:
    | "env_state_db"
    | "adapter_env_hermes_home"
    | "env_hermes_home"
    | "profile_arg"
    | "profile_config"
    | "wrapper_script"
    | "active_profile"
    | "root_fallback";
  profile: string | null;
}

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
  /** Whether the in-memory child handle (this server spawned it) was found. */
  inMemoryHandle: boolean;
  lastOutputAt: Date | null;
  /** Latest ledger activity for the run's session(s) since the run started. */
  ledgerActivityAt: Date | null;
  /** Earliest ledger activity since the run started: Hermes' first completed model call. */
  firstLedgerActivityAt: Date | null;
  ledgerPath: string | null;
  ledgerStatus: LedgerReadStatus;
  ledgerCertainty: LedgerCertainty | null;
  ledgerSource: HermesLedgerResolution["source"] | null;
  sessionIds: string[];
  /** Open sessions that started within the run's attribution window. */
  windowSessionIds: string[];
}

export interface LedgerActivity {
  status: LedgerReadStatus;
  sessionIds: string[];
  windowSessionIds: string[];
  /** Conservative "latest": the least recent of the attributed sessions' latest activity. */
  lastActivityAt: Date | null;
  /** Latest activity across every attributed session. */
  anyActivityAt: Date | null;
  firstActivityAt: Date | null;
}

export interface RunLivenessProbeOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the ledger resolution (tests, operators). */
  ledger?: HermesLedgerResolution | null;
  isPidAlive?: (pid: number) => boolean;
  isProcessGroupAlive?: (pgid: number) => boolean;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** adapterConfig.env values are plain strings or `{ type: "plain", value }` envelopes. */
function readEnvValue(env: Record<string, unknown> | null, key: string): string | null {
  const raw = env?.[key];
  if (typeof raw === "string") return readString(raw);
  const record = readRecord(raw);
  if (record?.type === "plain") return readString(record.value);
  return null;
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
 * nothing on this host to check.
 */
export function probeRunProcessAlive(
  run: RunForLivenessProbe,
  opts: RunLivenessProbeOptions = {},
): { alive: boolean | null; inMemoryHandle: boolean } {
  const running = runningProcesses.get(run.id);
  if (running) {
    return { alive: running.child.exitCode === null && running.child.signalCode === null, inMemoryHandle: true };
  }
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const isGroupAlive = opts.isProcessGroupAlive ?? defaultIsProcessGroupAlive;
  if (typeof run.processPid === "number" && run.processPid > 0) {
    if (isPidAlive(run.processPid)) return { alive: true, inMemoryHandle: false };
    if (typeof run.processGroupId === "number" && run.processGroupId > 0) {
      return { alive: isGroupAlive(run.processGroupId), inMemoryHandle: false };
    }
    return { alive: false, inMemoryHandle: false };
  }
  if (typeof run.processGroupId === "number" && run.processGroupId > 0) {
    return { alive: isGroupAlive(run.processGroupId), inMemoryHandle: false };
  }
  return { alive: null, inMemoryHandle: false };
}

/**
 * The start time the OS reports for a pid, or null when it cannot be read.
 * Used to make sure a persisted pid still names the process we spawned before
 * signalling it: after a server restart the pid may have been reused.
 */
export function readProcessStartTime(pid: number): Date | null {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      // ps prints local time and Date parses local time; only the locale is pinned.
      env: { ...process.env, LC_ALL: "C" },
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    const parsed = new Date(out);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

/** A persisted pid is the run's process only if the OS start time matches the recorded one. */
export function isSameProcess(
  pid: number,
  recordedStartedAt: Date | null | undefined,
  readStart: (pid: number) => Date | null = readProcessStartTime,
  toleranceMs = 5_000,
): boolean {
  if (!recordedStartedAt) return false;
  const actual = readStart(pid);
  if (!actual) return false;
  return Math.abs(actual.getTime() - recordedStartedAt.getTime()) <= toleranceMs;
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

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  if (command.includes("/") || command.includes(path.sep)) return existsSync(command) ? command : null;
  for (const dir of (env.PATH ?? process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * What a wrapper script says about its profile. Returns null when the command
 * is not a small text script or names no profile; a wrapper we cannot read
 * is treated as unknown, never guessed from its file name.
 */
function readWrapperProfile(
  commandPath: string,
): { profile: string | null; hermesHome: string | null } | null {
  try {
    const stat = statSync(commandPath);
    if (!stat.isFile() || stat.size > WRAPPER_MAX_BYTES) return null;
    const text = readFileSync(commandPath, "utf8");
    if (text.includes("\u0000")) return null;
    // Only a `-p`/`--profile` on a line that invokes hermes counts (not `mkdir -p`).
    const profile = /hermes\S*["']?\s(?:[^\n]*\s)?(?:-p|--profile)(?:\s+|=)["']?([A-Za-z0-9_.-]+)/.exec(text)?.[1] ?? null;
    const hermesHome = /HERMES_HOME=["']?([^"'\s;]+)/.exec(text)?.[1] ?? null;
    if (!profile && !hermesHome) return null;
    return { profile, hermesHome };
  } catch {
    return null;
  }
}

/**
 * Which Hermes ledger a run writes to, and how sure we are.
 *
 * Certain: `AGENTDASH_HERMES_STATE_DB`; a `HERMES_HOME` the run's own
 * `adapterConfig.env` sets; the server's `HERMES_HOME`; an explicit
 * `-p/--profile` (args or config) naming an existing profile; a wrapper
 * script whose text names the profile or `HERMES_HOME`.
 * Uncertain: the sticky `active_profile` (Hermes' own default when no `-p`
 * is given, but it can change under a running agent), and the root ledger.
 */
export function resolveHermesLedgerForRun(
  adapterConfig: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HermesLedgerResolution {
  const explicit = readString(env.AGENTDASH_HERMES_STATE_DB);
  if (explicit) return { path: path.resolve(explicit), certainty: "certain", source: "env_state_db", profile: null };

  const config = adapterConfig ?? {};
  const adapterEnvHome = readEnvValue(readRecord(config.env), "HERMES_HOME");
  if (adapterEnvHome) {
    return { path: path.resolve(adapterEnvHome, "state.db"), certainty: "certain", source: "adapter_env_hermes_home", profile: null };
  }
  const serverHome = readString(env.HERMES_HOME);
  if (serverHome) {
    return { path: path.resolve(serverHome, "state.db"), certainty: "certain", source: "env_hermes_home", profile: null };
  }

  const hermesRoot = readString(env.AGENTDASH_HERMES_ROOT) ?? path.join(os.homedir(), ".hermes");
  const profilesDir = readString(env.HERMES_PROFILES_DIR) ?? path.join(hermesRoot, "profiles");
  const profileDb = (profile: string | null) =>
    profile && PROFILE_NAME.test(profile) && existsSync(path.join(profilesDir, profile, "state.db"))
      ? path.join(profilesDir, profile, "state.db")
      : null;

  const argProfile = hermesProfileFromArgs(config.extraArgs) ?? hermesProfileFromArgs(config.args);
  const argDb = profileDb(argProfile);
  if (argDb) return { path: argDb, certainty: "certain", source: "profile_arg", profile: argProfile };

  const configProfile = readString(config.hermesProfile) ?? readString(config.profile);
  const configDb = profileDb(configProfile);
  if (configDb) return { path: configDb, certainty: "certain", source: "profile_config", profile: configProfile };

  const command = readString(config.hermesCommand) ?? readString(config.command);
  const commandPath = command ? findOnPath(command, env) : null;
  const wrapper = commandPath ? readWrapperProfile(commandPath) : null;
  if (wrapper?.hermesHome) {
    return { path: path.resolve(wrapper.hermesHome, "state.db"), certainty: "certain", source: "wrapper_script", profile: null };
  }
  const wrapperDb = profileDb(wrapper?.profile ?? null);
  if (wrapperDb) return { path: wrapperDb, certainty: "certain", source: "wrapper_script", profile: wrapper!.profile };

  let active: string | null = null;
  try {
    active = readString(readFileSync(path.join(hermesRoot, "active_profile"), "utf8"));
  } catch {
    active = null;
  }
  const activeDb = active && active !== "default" ? profileDb(active) : null;
  if (activeDb) return { path: activeDb, certainty: "uncertain", source: "active_profile", profile: active };
  return { path: path.join(hermesRoot, "state.db"), certainty: "uncertain", source: "root_fallback", profile: null };
}

function toDate(seconds: unknown): Date | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

/**
 * Read-only view of what a Hermes ledger says about a run.
 *
 * Attribution: the resumed session (`sessionIdBefore`) and its compaction
 * children when it has activity since the run started; otherwise every
 * session that opened after the run started and has not ended. When several
 * such open sessions exist (agents sharing a profile), `lastActivityAt` is the
 * least recent of them, so another agent's progress can never make a stuck
 * run look alive. `windowSessionIds` are the open sessions that started
 * within the run's attribution window: the only ones that can justify
 * stopping it. Every failure is reported as a status, never thrown.
 */
export function readHermesLedgerActivity(input: {
  ledgerPath: string;
  sessionId?: string | null;
  runStartedAt: Date;
}): LedgerActivity {
  const empty = (status: LedgerReadStatus, windowSessionIds: string[] = []): LedgerActivity => ({
    status,
    sessionIds: [],
    windowSessionIds,
    lastActivityAt: null,
    anyActivityAt: null,
    firstActivityAt: null,
  });
  if (!existsSync(input.ledgerPath)) return empty("missing");

  const startMs = input.runStartedAt.getTime();
  const sinceSec = startMs / 1000;
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
        const first = firstRaw && last ? new Date(Math.max(firstRaw.getTime(), startMs)) : null;
        rows.push({ sessionId, first, last });
      }
      return rows;
    };

    const openSessions = db
      .prepare(`SELECT id, started_at FROM sessions WHERE started_at >= ? AND ended_at IS NULL`)
      .all(sinceSec - SESSION_START_SLACK_MS / 1000) as Array<{ id: string; started_at: number }>;
    const windowSessionIds = openSessions
      .filter((row) => row.started_at * 1000 <= startMs + SESSION_ATTRIBUTION_WINDOW_MS)
      .map((row) => row.id);

    let attributed = [] as ReturnType<typeof activityFor>;
    const sessionId = readString(input.sessionId);
    if (sessionId) {
      attributed = activityFor([sessionId]).filter((row) => row.last !== null);
    }
    if (attributed.length === 0) {
      attributed = activityFor(openSessions.map((row) => row.id));
    }
    if (attributed.length === 0) return empty("read", windowSessionIds);

    const lasts = attributed.map((row) => row.last?.getTime() ?? null);
    const firsts = attributed.map((row) => row.first?.getTime()).filter((value): value is number => value != null);
    const anyLast = lasts.filter((value): value is number => value != null);
    return {
      status: "read",
      sessionIds: attributed.map((row) => row.sessionId),
      windowSessionIds,
      lastActivityAt: lasts.some((value) => value === null) ? null : new Date(Math.min(...(lasts as number[]))),
      anyActivityAt: anyLast.length > 0 ? new Date(Math.max(...anyLast)) : null,
      firstActivityAt: firsts.length > 0 ? new Date(Math.min(...firsts)) : null,
    };
  } catch {
    // Locked, corrupt, or a schema this query does not know.
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
  const processState = probeRunProcessAlive(run, opts);
  const base: RunLivenessEvidence = {
    probe: "output",
    processAlive: processState.alive,
    inMemoryHandle: processState.inMemoryHandle,
    lastOutputAt: run.lastOutputAt ?? null,
    ledgerActivityAt: null,
    firstLedgerActivityAt: null,
    ledgerPath: null,
    ledgerStatus: "not_applicable",
    ledgerCertainty: null,
    ledgerSource: null,
    sessionIds: [],
    windowSessionIds: [],
  };
  if (!isLedgerProbedAdapter(agent.adapterType)) return base;

  const resolution = opts.ledger ?? resolveHermesLedgerForRun(readRecord(agent.adapterConfig), opts.env);
  const withLedger = {
    ...base,
    probe: "hermes_ledger" as const,
    ledgerPath: resolution.path,
    ledgerCertainty: resolution.certainty,
    ledgerSource: resolution.source,
  };
  const startedAt = runStartedAt(run);
  if (!startedAt) return { ...withLedger, ledgerStatus: "unreadable" };
  const activity = readHermesLedgerActivity({ ledgerPath: resolution.path, sessionId: run.sessionIdBefore, runStartedAt: startedAt });
  return {
    ...withLedger,
    ledgerStatus: activity.status,
    sessionIds: activity.sessionIds,
    windowSessionIds: activity.windowSessionIds,
    ledgerActivityAt: activity.lastActivityAt,
    firstLedgerActivityAt: activity.firstActivityAt ?? activity.anyActivityAt,
  };
}

/**
 * The moment silence is measured from. For a ledger-probed run whose process
 * is alive (or unobservable) and whose ledger was read, ledger activity counts
 * as activity; otherwise this is exactly the old output-silence start. This
 * only ever suppresses or softens a review ticket, so an uncertain ledger is
 * acceptable here.
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

export type FirstOutputDeadlineMode = "off" | "shadow" | "enforce";

/**
 * Whether the first-output deadline acts. Default `shadow`: it reports the
 * runs it would stop (a `would_stop_no_first_output` run event and a run-log
 * line) and stops nothing. `adapterConfig.firstOutputDeadlineMode` wins over
 * `AGENTDASH_FIRST_OUTPUT_DEADLINE_MODE`; each takes `off`, `shadow` or
 * `enforce`.
 */
export function resolveFirstOutputDeadlineMode(
  adapterConfig: unknown,
  env: NodeJS.ProcessEnv = process.env,
): FirstOutputDeadlineMode {
  const parse = (value: unknown): FirstOutputDeadlineMode | null => {
    const text = readString(value)?.toLowerCase();
    return text === "off" || text === "shadow" || text === "enforce" ? text : null;
  };
  return parse(readRecord(adapterConfig)?.firstOutputDeadlineMode)
    ?? parse(env.AGENTDASH_FIRST_OUTPUT_DEADLINE_MODE)
    ?? "shadow";
}

/**
 * The first-output deadline for an agent, in ms, or null when disabled.
 *
 * `adapterConfig.firstOutputDeadlineSec` wins (0 disables). Otherwise
 * `AGENTDASH_FIRST_OUTPUT_DEADLINE_MS` (0 disables), otherwise 10 minutes for
 * ledger-probed adapters. Streaming adapters are opt-in through the config
 * key, and only ever in shadow (see `classifyFirstOutput`).
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

export type FirstOutputVerdict =
  /** Model work was seen; nothing to do. */
  | { kind: "seen" }
  /** No evidence either way (ledger missing or unreadable, no start time). */
  | { kind: "unknown"; reason: string }
  /** No first output, but the evidence is not strong enough to stop the run. */
  | { kind: "none_uncertain"; reason: string }
  /** No first output, on a ledger resolved with certainty and a session attributed to this run. */
  | { kind: "none_certain"; reason: string };

/**
 * Judge first output. Only `none_certain` may ever stop a run, and only when:
 * the ledger was resolved with certainty, it was read, at least one open
 * session started within this run's attribution window, none of the attributed
 * sessions has a usage row since the run started, and the process start time
 * is known (not merely the run's queue start).
 */
export function classifyFirstOutput(run: RunForLivenessProbe, evidence: RunLivenessEvidence): FirstOutputVerdict {
  if (evidence.probe !== "hermes_ledger") {
    if (run.lastOutputAt && run.processStartedAt && run.lastOutputAt.getTime() >= run.processStartedAt.getTime()) {
      return { kind: "seen" };
    }
    // Output progress is flushed to the row at most once a minute and the
    // adapter's own pre-spawn lines count as output, so for streaming adapters
    // this can only ever be reported.
    return { kind: "none_uncertain", reason: "streaming adapter: last_output_at cannot prove the absence of output" };
  }
  if (evidence.ledgerStatus !== "read") return { kind: "unknown", reason: `ledger ${evidence.ledgerStatus}` };
  if (evidence.firstLedgerActivityAt) return { kind: "seen" };
  if (evidence.ledgerCertainty !== "certain") {
    return { kind: "none_uncertain", reason: `ledger resolved from ${evidence.ledgerSource ?? "unknown"}, not certain` };
  }
  if (evidence.windowSessionIds.length === 0) {
    return { kind: "none_uncertain", reason: "no session in the ledger attributable to this run" };
  }
  if (!run.processStartedAt) {
    return { kind: "none_uncertain", reason: "process start time unknown; clock started at the run start" };
  }
  return { kind: "none_certain", reason: `no ledger row for session ${evidence.windowSessionIds.join(", ")}` };
}
