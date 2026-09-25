import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AdapterExecutionResult, UsageSummary } from "@paperclipai/adapter-utils";

/**
 * Token metering for `hermes_local`.
 *
 * Everything downstream already meters: an adapter returns `usage`, the
 * heartbeat writes `heartbeat_runs.usage_json`, and /costs/by-agent aggregates
 * input, cached and output tokens by agent, model, provider and biller.
 * codex_local fills that in. hermes_local did not, so the one agent MKThink
 * runs reported nothing while its costs page read zero against real spend.
 *
 * Two earlier readings of this were wrong, and both are worth recording so
 * nobody spends the evening rediscovering them:
 *
 *   1. The adapter package scrapes totals out of stdout with a regex. Hermes
 *      0.20 prints no such line — a whole successful run whose log never says
 *      the word "token".
 *   2. Hermes has `--usage-file PATH`, which looks like the answer and is not:
 *      it is documented "One-shot mode only … No effect outside -z/--oneshot",
 *      and this adapter runs the `chat` subcommand. Passed there, Hermes exits
 *      with `unrecognized arguments: --usage-file`. Measured in production.
 *
 * What Hermes does keep, for every run and without being asked, is its own
 * ledger: `session_model_usage` in `~/.hermes/state.db`, one row per model per
 * task, carrying api_call_count, input/output/cache/reasoning tokens and both
 * estimated and actual cost. That is the number, from the process that spent
 * it, recorded whether or not anyone thought to ask for it.
 */

/** The subset of Hermes' ledger this adapter trusts. */
export interface HermesSessionUsage {
  /** Cumulative session totals — see `applyHermesSessionUsage`. */
  usage: UsageSummary;
  model: string | null;
  provider: string | null;
  /** Only set when Hermes itself recorded a non-zero cost. */
  costUsd: number | null;
  apiCalls: number;
  /** Cumulative `sessions.tool_call_count`, when the ledger recorded it. */
  toolCalls: number | null;
}

export type HermesMeteringStatus =
  | "metered"
  | "unmetered_no_ledger"
  | "unmetered_no_session";

/**
 * The result of trying to read the ledger, with the failure mode kept. A run
 * whose metering failed must be able to say *why* — "unmetered" is a fact about
 * the record, not a zero.
 */
export interface HermesSessionUsageRead {
  usage: HermesSessionUsage | null;
  status: HermesMeteringStatus;
  /** Which candidate file answered (or was tried last), for diagnostics. */
  dbPath: string | null;
}

/** One `session_model_usage` row, as far as this module cares. */
export interface HermesUsageRow {
  model?: unknown;
  billing_provider?: unknown;
  api_call_count?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
  estimated_cost_usd?: unknown;
  actual_cost_usd?: unknown;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// ── Ledger location ──────────────────────────────────────────────────────
//
// One resolver answers "which state.db does this Hermes run write" for both
// readers: metering below, which tries every candidate in order, and the
// liveness probe (`services/run-liveness-probe.ts`), which needs the single
// best answer plus how sure it is — a `certain` resolution is what licenses
// the probe's first-output deadline to act. OBS-5's probe kept its own copy
// of this logic; OBS-1 folded the two together so the answer can never drift
// between "where we meter" and "where we look for signs of life".

/** `certain`: the run provably writes this ledger. `uncertain`: a best guess (sticky active profile, root fallback). */
export type HermesStateDbCertainty = "certain" | "uncertain";

/** How the path was found, for evidence and logs. */
export type HermesStateDbSource =
  | "profile_hint"
  | "env_state_db"
  | "adapter_env_hermes_home"
  | "env_hermes_home"
  | "profile_arg"
  | "profile_config"
  | "wrapper_script"
  | "active_profile"
  | "root_fallback";

export interface HermesStateDbResolution {
  path: string;
  certainty: HermesStateDbCertainty;
  source: HermesStateDbSource;
  profile: string | null;
}

export interface HermesStateDbResolveOptions {
  env?: NodeJS.ProcessEnv;
  /** The run's adapter config — `env`, `extraArgs`/`args`, `hermesProfile`, `hermesCommand`. */
  adapterConfig?: Record<string, unknown> | null;
  /**
   * The profile this run provably used — e.g. derived from the command the
   * adapter actually invoked. Asserted evidence rather than inference, so it
   * ranks first and is not gated on the ledger file existing yet.
   */
  profile?: string | null;
}

const WRAPPER_MAX_BYTES = 64 * 1024;
const PROFILE_NAME = /^[A-Za-z0-9_.-]+$/;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** adapterConfig.env values are plain strings or `{ type: "plain", value }` envelopes. */
function readEnvValue(env: Record<string, unknown> | null, key: string): string | null {
  const raw = env?.[key];
  if (typeof raw === "string") return readString(raw);
  const record = readRecord(raw);
  if (record?.type === "plain") return readString(record.value);
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
 * Where Hermes keeps its state, strongest evidence first.
 *
 * Certain sources, in order: the caller-asserted profile (the run provably
 * used it — a `hermes -p` run writes `<profilesDir>/<name>/state.db` wherever
 * the unmanaged database lives); `AGENTDASH_HERMES_STATE_DB`, the operator
 * override for a relocated unmanaged database; a `HERMES_HOME` the run's own
 * `adapterConfig.env` sets; the server's `HERMES_HOME`; an explicit
 * `-p/--profile` (args or config) or a wrapper script whose text names the
 * profile or `HERMES_HOME` — gated on the profile ledger existing, because a
 * `-p` naming a profile Hermes never created says nothing about where this
 * run writes.
 *
 * Uncertain sources, in order: the sticky `active_profile` (Hermes' own
 * default when no `-p` is given, but it can change under a running agent) and
 * the root ledger. `HERMES_PROFILES_DIR` is resolved exactly like
 * `hermes-profile.ts` does; `AGENTDASH_HERMES_ROOT` overrides the Hermes root
 * (tests, relocated installs).
 */
export function resolveHermesStateDbResolutions(
  opts: HermesStateDbResolveOptions = {},
): HermesStateDbResolution[] {
  const env = opts.env ?? process.env;
  const config = readRecord(opts.adapterConfig) ?? {};
  const resolutions: HermesStateDbResolution[] = [];
  const push = (
    dbPath: string,
    source: HermesStateDbSource,
    certainty: HermesStateDbCertainty,
    profile: string | null,
  ) => {
    if (!resolutions.some((r) => r.path === dbPath)) {
      resolutions.push({ path: dbPath, source, certainty, profile });
    }
  };

  const hermesRoot = readString(env.AGENTDASH_HERMES_ROOT) ?? path.join(os.homedir(), ".hermes");
  const profilesDir = readString(env.HERMES_PROFILES_DIR) ?? path.join(hermesRoot, "profiles");
  const existingProfileDb = (profile: string | null) =>
    profile && PROFILE_NAME.test(profile) && existsSync(path.join(profilesDir, profile, "state.db"))
      ? path.join(profilesDir, profile, "state.db")
      : null;

  const hinted = readString(opts.profile);
  if (hinted && PROFILE_NAME.test(hinted)) {
    push(path.join(profilesDir, hinted, "state.db"), "profile_hint", "certain", hinted);
  }

  const explicit = readString(env.AGENTDASH_HERMES_STATE_DB);
  if (explicit) push(path.resolve(explicit), "env_state_db", "certain", null);

  const adapterEnvHome = readEnvValue(readRecord(config.env), "HERMES_HOME");
  if (adapterEnvHome) {
    push(path.resolve(adapterEnvHome, "state.db"), "adapter_env_hermes_home", "certain", null);
  }
  const serverHome = readString(env.HERMES_HOME);
  if (serverHome) push(path.resolve(serverHome, "state.db"), "env_hermes_home", "certain", null);

  const argProfile = hermesProfileFromArgs(config.extraArgs) ?? hermesProfileFromArgs(config.args);
  const argDb = existingProfileDb(argProfile);
  if (argDb) push(argDb, "profile_arg", "certain", argProfile);

  const configProfile = readString(config.hermesProfile) ?? readString(config.profile);
  const configDb = existingProfileDb(configProfile);
  if (configDb) push(configDb, "profile_config", "certain", configProfile);

  const command = readString(config.hermesCommand) ?? readString(config.command);
  const commandPath = command ? findOnPath(command, env) : null;
  const wrapper = commandPath ? readWrapperProfile(commandPath) : null;
  if (wrapper?.hermesHome) {
    push(path.resolve(wrapper.hermesHome, "state.db"), "wrapper_script", "certain", null);
  }
  const wrapperDb = existingProfileDb(wrapper?.profile ?? null);
  if (wrapperDb) push(wrapperDb, "wrapper_script", "certain", wrapper!.profile);

  let active: string | null = null;
  try {
    active = readString(readFileSync(path.join(hermesRoot, "active_profile"), "utf8"));
  } catch {
    active = null;
  }
  const activeDb = active && active !== "default" ? existingProfileDb(active) : null;
  if (activeDb) push(activeDb, "active_profile", "uncertain", active);

  push(path.join(hermesRoot, "state.db"), "root_fallback", "uncertain", null);
  return resolutions;
}

/** The single best answer — the probe's certainty-gated resolution. */
export function resolveHermesStateDbResolution(
  opts: HermesStateDbResolveOptions = {},
): HermesStateDbResolution {
  return resolveHermesStateDbResolutions(opts)[0]!;
}

/** Every candidate in precedence order — metering tries each until one answers. */
export function resolveHermesStateDbCandidates(
  env: NodeJS.ProcessEnv = process.env,
  opts: Omit<HermesStateDbResolveOptions, "env"> = {},
): string[] {
  return resolveHermesStateDbResolutions({ ...opts, env }).map((r) => r.path);
}

export function resolveHermesStateDbPath(
  env: NodeJS.ProcessEnv = process.env,
  opts: Omit<HermesStateDbResolveOptions, "env"> = {},
): string {
  return resolveHermesStateDbResolution({ ...opts, env }).path;
}

/**
 * Sum a session's rows into one usage summary.
 *
 * Hermes writes a row per model per task, so a session that summarised itself
 * with a second model has several. Summing is what a bill does; the model and
 * provider reported are the ones that did the most work, because a single
 * label has to stand for the run and the summariser is not the story.
 *
 * A cost of zero is dropped rather than reported. On the MKThink Mini every
 * MiniMax row carries `estimated_cost_usd 0.0` and `actual_cost_usd 0.0` —
 * Hermes has the token counts and not the price list. Writing that zero into a
 * cost event would put "$0.00 spent" on a board that is spending money, which
 * is a false statement rather than a gap. Tokens land either way.
 */
export function summarizeHermesUsageRows(rows: readonly HermesUsageRow[]): HermesSessionUsage | null {
  if (rows.length === 0) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let apiCalls = 0;
  let costUsd = 0;
  let dominant: { model: string | null; provider: string | null; tokens: number } | null = null;

  for (const row of rows) {
    const rowInput = readNumber(row.input_tokens);
    const rowOutput = readNumber(row.output_tokens);
    inputTokens += rowInput;
    outputTokens += rowOutput;
    cachedInputTokens += readNumber(row.cache_read_tokens);
    apiCalls += readNumber(row.api_call_count);
    costUsd += readNumber(row.actual_cost_usd) || readNumber(row.estimated_cost_usd);

    const rowTokens = rowInput + rowOutput;
    if (!dominant || rowTokens > dominant.tokens) {
      dominant = {
        model: readString(row.model),
        provider: readString(row.billing_provider),
        tokens: rowTokens,
      };
    }
  }

  if (inputTokens === 0 && outputTokens === 0) return null;

  return {
    usage: {
      inputTokens,
      outputTokens,
      ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    },
    model: dominant?.model ?? null,
    provider: dominant?.provider ?? null,
    costUsd: costUsd > 0 ? costUsd : null,
    apiCalls,
    toolCalls: null,
  };
}

/**
 * Read one session's usage out of Hermes' state database, trying each
 * candidate file in order (managed profile first, then the home database).
 *
 * Read-only, and every failure is recorded rather than thrown: metering is a
 * by-product of the run, and a database that is missing, locked, or newer than
 * this query must never turn a completed run into a failed one — but the run
 * record must say `unmetered_*` instead of silently reading as zero.
 */
export function readHermesSessionUsageDetailed(
  sessionId: string | null | undefined,
  opts: {
    dbPath?: string;
    profile?: string | null;
    adapterConfig?: Record<string, unknown> | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): HermesSessionUsageRead {
  const session = readString(sessionId);
  if (!session) {
    return { usage: null, status: "unmetered_no_session", dbPath: null };
  }
  const candidates = opts.dbPath
    ? [opts.dbPath]
    : resolveHermesStateDbCandidates(opts.env, {
        profile: opts.profile,
        adapterConfig: opts.adapterConfig,
      });

  let sawReadableDb = false;
  let lastTried: string | null = null;
  for (const dbPath of candidates) {
    lastTried = dbPath;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      sawReadableDb = true;
      const rows = db
        .prepare(
          `SELECT model, billing_provider, api_call_count, input_tokens, output_tokens,
                  cache_read_tokens, estimated_cost_usd, actual_cost_usd
             FROM session_model_usage
            WHERE session_id = ?`,
        )
        .all(session) as HermesUsageRow[];
      const usage = summarizeHermesUsageRows(rows);
      if (usage) {
        usage.toolCalls = readHermesSessionToolCalls(db, session);
        return { usage, status: "metered", dbPath };
      }
      // A readable database without this session keeps looking — a run can be
      // misattributed to a profile it never used, and the home database may
      // still hold it.
    } catch {
      // Unreadable candidate — try the next one.
    } finally {
      try {
        db?.close();
      } catch {
        // Nothing useful to do with a close failure on a read-only handle.
      }
    }
  }
  return {
    usage: null,
    status: sawReadableDb ? "unmetered_no_session" : "unmetered_no_ledger",
    dbPath: lastTried,
  };
}

/** `sessions.tool_call_count` — cumulative for the session, null when absent. */
function readHermesSessionToolCalls(db: DatabaseSync, sessionId: string): number | null {
  try {
    const row = db
      .prepare(`SELECT tool_call_count FROM sessions WHERE id = ?`)
      .get(sessionId) as { tool_call_count?: unknown } | undefined;
    const count = row?.tool_call_count;
    return typeof count === "number" && Number.isFinite(count) && count >= 0
      ? Math.floor(count)
      : null;
  } catch {
    // Older ledgers may lack the table or column — tools stay unrecorded.
    return null;
  }
}

export function readHermesSessionUsage(
  sessionId: string | null | undefined,
  opts: {
    dbPath?: string;
    profile?: string | null;
    adapterConfig?: Record<string, unknown> | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): HermesSessionUsage | null {
  return readHermesSessionUsageDetailed(sessionId, opts).usage;
}

/** Find the Hermes session a result belongs to, wherever the adapter put it. */
export function readHermesSessionId(result: AdapterExecutionResult): string | null {
  const sessionParams =
    result.sessionParams && typeof result.sessionParams === "object" && !Array.isArray(result.sessionParams)
      ? (result.sessionParams as Record<string, unknown>)
      : null;
  const resultJson =
    result.resultJson && typeof result.resultJson === "object" && !Array.isArray(result.resultJson)
      ? (result.resultJson as Record<string, unknown>)
      : null;

  return (
    readString(result.sessionId)
    ?? readString(sessionParams?.sessionId)
    ?? readString(resultJson?.session_id)
    ?? readString(result.sessionDisplayId)
  );
}

/**
 * Fold the ledger into the adapter's result.
 *
 * The totals are CUMULATIVE for the session, which is the shape the platform
 * already expects from a resuming adapter: `deriveNormalizedUsageDelta` in the
 * heartbeat subtracts the previous run's raw totals for the same session, so a
 * ten-run session bills ten deltas rather than ten copies of the total.
 *
 * Nothing the adapter already established is overwritten: it knows which
 * profile ran and which model label a human configured, and the ledger merely
 * repeating those must not clobber them.
 */
/**
 * Values the adapter emits when it does not know.
 *
 * `provider: "auto"` means "Hermes picked one", which buckets real spend under
 * a non-answer in /costs/by-provider. The ledger records which provider was
 * actually billed, so a placeholder must not outrank it — while a genuine
 * label a human configured still wins.
 */
const PLACEHOLDER_LABELS = new Set(["auto", "unknown", "default", "none"]);

function isInformative(value: unknown): value is string {
  const label = readString(value);
  return label !== null && !PLACEHOLDER_LABELS.has(label.toLowerCase());
}

export function applyHermesSessionUsage(
  result: AdapterExecutionResult,
  usage: HermesSessionUsage | null,
): AdapterExecutionResult {
  if (!usage) return result;
  // AGE-142 (S3): the recovery budget reads turns from resultJson.num_turns
  // (task-recovery-budget.ts), but nothing in this repo ever wrote it, so the
  // turns dimension sat silently at zero and could never exhaust. The ledger's
  // per-model API call counts are that number, from the process that spent
  // them. Cumulative-session caveat, recorded where the write happens: hermes
  // totals are per session, so on a resumed session this reports the
  // session-so-far figure rather than a per-run delta — an overcount that can
  // only bias the budget toward stopping sooner, never toward overspending.
  // A natively reported count the adapter already established is not clobbered.
  const existingResultJson =
    result.resultJson && typeof result.resultJson === "object" && !Array.isArray(result.resultJson)
      ? result.resultJson
      : {};
  const existingTurns = readNumber(
    existingResultJson.num_turns ?? existingResultJson.numTurns,
  );
  const existingToolCalls = readNumber(existingResultJson.num_tool_calls);
  const mergedResultJson = {
    ...existingResultJson,
    ...(existingTurns > 0 || usage.apiCalls <= 0 ? {} : { num_turns: usage.apiCalls }),
    ...(existingToolCalls > 0 || usage.toolCalls == null
      ? {}
      : { num_tool_calls: usage.toolCalls }),
  };
  return {
    ...result,
    ...(Object.keys(mergedResultJson).length > Object.keys(existingResultJson).length
      ? { resultJson: mergedResultJson }
      : {}),
    usage: result.usage ?? usage.usage,
    ...(isInformative(result.model) ? {} : usage.model ? { model: usage.model } : {}),
    ...(isInformative(result.provider) ? {} : usage.provider ? { provider: usage.provider } : {}),
    ...(result.costUsd === undefined || result.costUsd === null
      ? usage.costUsd !== null
        ? { costUsd: usage.costUsd }
        : {}
      : {}),
  };
}
